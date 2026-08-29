import { getInput, info, error, setFailed } from "@actions/core";
import { context, getOctokit } from "@actions/github";
import { glob } from "glob";
import { execSync, SpawnSyncReturns } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import * as path from "node:path";

interface CommitAuthor {
    date?: string,
    email: string | null,
    name: string,
    username?: string,
}

interface Commit {
    added?: string[],
    author: CommitAuthor,
    committer: CommitAuthor,
    distinct: boolean,
    id: string,
    message: string,
    modified?: string[],
    removed?: string[],
    timestamp: string,
    tree_id: string,
    url: string,
}

const EMPTY_BEFORE_SHA = "0000000000000000000000000000000000000000";

async function getPotentialPackageDirs(userscriptsDir: string): Promise<string[]> {
    return (await readdir(userscriptsDir, { withFileTypes: true }))
        .filter((dirent) => dirent.isDirectory())
        .map((dirent) => path.join(userscriptsDir, dirent.name));
}

interface LoadedPackage {
    name: string;
    version: string;
    files: string[];
    path: string;
    // files: [fileName: string, content: string][];
    // outputHash: string;
    commitSha: string;
}

async function tryLoadPackage(packagePath: string, commitSha: string): Promise<LoadedPackage | null> {
    const packageJsonPath = path.join(packagePath, "package.json");

    let packageRaw: string;
    try {
        packageRaw = await readFile(packageJsonPath, { encoding: "utf-8" });
    } catch {
        return null;
    }

    const packageJson = JSON.parse(packageRaw);

    if (typeof packageJson !== "object" || packageJson === null) throw Error(`${packagePath} was not an object!`);

    if (!("name" in packageJson)) throw Error(`${packagePath} did not have a "name" property!`);
    const { name } = packageJson;
    if (typeof name !== "string") throw Error(`${packagePath} "name" property was not a string!`);

    if (!("version" in packageJson)) throw Error(`${packagePath} did not have a "version" property!`);
    const { version } = packageJson;
    if (typeof version !== "string") throw Error(`${packagePath} "version" property was not a string!`);

    if (!("files" in packageJson)) throw Error(`${packagePath} did not have a "files" property!`);
    const { files } = packageJson;
    if (!Array.isArray(files)) throw Error(`${packagePath} "files" property was not an array!`);
    if (!files.every((v) => typeof v === "string")) throw Error(`${packagePath} "files" array was not all strings!`);

    return { name, version, files, path: packagePath, commitSha };
}

interface BuiltPackage {
    files: [string, Buffer][],
}

interface UserscriptMetadata {
    downloadURL?: string,
    updateURL?: string,
}

async function tryBuildPackage(loadedPackage: LoadedPackage, buildCommand: string, metadata: UserscriptMetadata): Promise<BuiltPackage | null> {
    try {
        info("Running build command");
        execSync(buildCommand, {
            cwd: loadedPackage.path,
            env: {
                ...process.env,
                USERSCRIPT_DOWNLOAD_URL: metadata.downloadURL,
                USERSCRIPT_UPDATE_URL: metadata.updateURL,
            }
        });
    } catch (e) {
        const error = e as Error & SpawnSyncReturns<Buffer>;
        throw Error([
            `Error executing build command: ${error.message}`,
            error.stdout.toString(),
            error.stderr.toString(),
        ].filter(Boolean).join("\n"));
    }

    const fileNames = await glob(loadedPackage.files, { cwd: loadedPackage.path });

    const files = await Promise.all(
        fileNames.map<Promise<[string, Buffer]>>(async (filename) => [
            filename,
            await readFile(path.join(loadedPackage.path, filename)),
        ]),
    );

    return { files };
}

function hashPackage(builtPackage: BuiltPackage): string {
    const hash = createHash("sha256");
    for (const [fileName, content] of [...builtPackage.files].sort(([a], [b]) => a.localeCompare(b))) {
        hash.update(fileName);
        hash.update("\0");
        hash.update(content);
        hash.update("\0");
    }

    return hash.digest("hex");
}

async function publishTagAndRelease(
    octokit: ReturnType<typeof getOctokit>,
    owner: string,
    repo: string,
    sha: string,
    tagName: string,
    files: [string, Buffer][],
    forceMoveTag: boolean,
) {
    info(`Creating new release ${tagName}`);
    const tagExists = execSync(`git tag -l "${tagName}"`).toString().trim() !== "";

    if (tagExists) {
        if (!forceMoveTag) {
            info(`Tag ${tagName} already exists, skipping`);
            return;
        }

        execSync(`git tag -f ${tagName} ${sha}`);
        execSync(`git push origin -f refs/tags/${tagName}`);

        try {
            const existing = await octokit.rest.repos.getReleaseByTag({ owner, repo, tag: tagName });
            await octokit.rest.repos.deleteRelease({ owner, repo, release_id: existing.data.id });
        } catch {
            // getReleaseByTag throws if nothing found, I think - it's okay if it doesn't exist, we're going to create it
        }
    } else {
        execSync(`git tag ${tagName} ${sha}`);
        execSync(`git push origin refs/tags/${tagName}`);
    }

    const release = await octokit.rest.repos.createRelease({
        owner,
        repo,
        tag_name: tagName,
        name: tagName,
        target_commitish: sha,
        draft: false,
        prerelease: false,
        make_latest: "false",
    });

    await Promise.all(
        files.map(([fileName, content]) =>
            octokit.rest.repos.uploadReleaseAsset({
                owner,
                repo,
                release_id: release.data.id,
                name: path.basename(fileName),
                data: content.toString(),
            }),
        ),
    );
}

interface PackageState {
    lastVersion: string | null,
    versionHasChanged: boolean,
    latestVersionedPackage?: LoadedPackage,
    lastOutputHash: string | null,
    hashHasChanged: boolean,
    latestDevPackage?: LoadedPackage,
}

const downloadBase = `https://github.com/${context.repo.owner}/${context.repo.repo}/releases/download/`

async function run() {
    if (context.eventName !== "push") throw Error(`userscript-monorepo-action expects to be run on 'push' event! (got ${context.eventName})`);

    const token = getInput("token");
    const octokit = getOctokit(token);

    const userscriptsDir = getInput("userscripts-dir", { required: true });
    const setupCommand = getInput("setup-command");
    const buildCommand = getInput("build-command");

    const commits = context.payload.commits as Commit[];
    if (commits.length === 0) {
        info("No commits in this push. Nothing to do.");
        return;
    }

    info(`Analyzing ${commits.length} commit${commits.length === 1 ? "" : "s"}`);

    // fetch all tags, required for forceMoveTag to work
    execSync(`git fetch --quiet --tags`);

    const commitShas = commits.map(commit => commit.id);

    const before = context.payload.before;

    const state: Record<string, PackageState> = {};

    if (before !== EMPTY_BEFORE_SHA) {
        info("Checkout out commit before push");
        execSync(`git fetch --quiet --depth=1 origin ${before}`);
        execSync(`git checkout --quiet ${before}`);
        try {
            info("Running setup command");
            execSync(setupCommand);
        } catch (e) {
            const error = e as Error & SpawnSyncReturns<Buffer>;
            throw Error([
                `Error executing setup command: ${error.message}`,
                error.stdout.toString(),
                error.stderr.toString(),
            ].filter(Boolean).join("\n"));
        }

        for (const packagePath of await getPotentialPackageDirs(userscriptsDir)) {
            const loadedPackage = await tryLoadPackage(packagePath, before).catch((err: Error) => {
                error(err);
                return null;
            });
            if (loadedPackage === null) continue;

            info(`Loaded package "${loadedPackage.name}"`);

            const builtPackage = await tryBuildPackage(loadedPackage, buildCommand, {}).catch((err: Error) => {
                error(err);
                return null;
            });
            if (builtPackage === null) continue;

            info(`Built package ${loadedPackage.name}"`);

            const hash = hashPackage(builtPackage);

            state[loadedPackage.name] = {
                lastVersion: loadedPackage.version,
                versionHasChanged: false,
                lastOutputHash: hash,
                hashHasChanged: false,
            };
        }
    }

    for (const commitSha of commitShas) {
        info(`Checking out ${commitSha}`);
        execSync(`git fetch --quiet --depth=1 origin ${commitSha}`);
        execSync(`git checkout --quiet ${commitSha}`);
        try {
            info("Running setup command");
            execSync(setupCommand);
        } catch (e) {
            const error = e as Error & SpawnSyncReturns<Buffer>;
            throw Error([
                `Error executing setup command: ${error.message}`,
                error.stdout.toString(),
                error.stderr.toString(),
            ].filter(Boolean).join("\n"));
        }

        for (const packagePath of await getPotentialPackageDirs(userscriptsDir)) {
            const loadedPackage = await tryLoadPackage(packagePath, commitSha).catch((err: Error) => {
                error(err);
                return null;
            });
            if (loadedPackage === null) continue;

            info(`Loaded package "${loadedPackage.name}"`);

            const builtPackage = await tryBuildPackage(loadedPackage, buildCommand, {}).catch((err: Error) => {
                error(err);
                return null;
            });
            if (builtPackage === null) continue;

            info(`Built package ${loadedPackage.name}"`);

            const hash = hashPackage(builtPackage);

            let packageEntry = state[loadedPackage.name];
            if (packageEntry === undefined) {
                packageEntry = state[loadedPackage.name] = { lastVersion: null, versionHasChanged: false, lastOutputHash: null, hashHasChanged: false };
            }

            info(`Analyzing package "${loadedPackage.name}"`);

            if (hash !== packageEntry.lastOutputHash) {
                packageEntry.hashHasChanged = true;
                packageEntry.latestDevPackage = loadedPackage;
            }

            if (loadedPackage.version !== packageEntry.lastVersion) {
                // TODO: what if it's a lower (or already existing) version string?
                const tag = `${loadedPackage.name}@${loadedPackage.version}`;

                let scriptName: string | undefined = undefined;
                let metaName: string | undefined = undefined;
                for (const [filename] of builtPackage.files) {
                    if (filename.endsWith(".user.js")) scriptName = path.basename(filename);
                    else if (filename.endsWith(".meta.js")) metaName = path.basename(filename);
                }

                const metadata: UserscriptMetadata = {};
                if (scriptName) metadata.downloadURL = downloadBase + tag + "/" + scriptName;
                if (metaName) metadata.updateURL = downloadBase + tag + "/" + metaName;

                const versionedBuiltPackage = await tryBuildPackage(loadedPackage, buildCommand, metadata);
                if (versionedBuiltPackage === null) continue;

                await publishTagAndRelease(octokit, context.repo.owner, context.repo.repo, commitSha, tag, versionedBuiltPackage.files, false);

                packageEntry.versionHasChanged = true;
                packageEntry.latestVersionedPackage = loadedPackage;
            }

            packageEntry.lastVersion = loadedPackage.version;
            packageEntry.lastOutputHash = hash;
        }
    }

    for (const packageEntry of Object.values(state)) {
        if (packageEntry.versionHasChanged) {
            const loadedPackage = packageEntry.latestVersionedPackage!;
            execSync(`git checkout --quiet ${loadedPackage.commitSha}`);

            const tag = `${loadedPackage.name}@latest`;

            const builtPackage = await tryBuildPackage(loadedPackage, buildCommand, {}).catch((err: Error) => {
                error(err);
                return null;
            });
            if (builtPackage === null) continue;

            let scriptName: string | undefined = undefined;
            let metaName: string | undefined = undefined;
            for (const [filename] of builtPackage.files) {
                if (filename.endsWith(".user.js")) scriptName = path.basename(filename);
                else if (filename.endsWith(".meta.js")) metaName = path.basename(filename);
            }

            const metadata: UserscriptMetadata = {};
            if (scriptName) metadata.downloadURL = downloadBase + tag + "/" + scriptName;
            if (metaName) metadata.updateURL = downloadBase + tag + "/" + metaName;

            const versionedBuiltPackage = await tryBuildPackage(loadedPackage, buildCommand, metadata);
            if (versionedBuiltPackage === null) continue;

            await publishTagAndRelease(octokit, context.repo.owner, context.repo.repo, loadedPackage.commitSha, tag, versionedBuiltPackage.files, true)
        }
        if (packageEntry.hashHasChanged) {
            const loadedPackage = packageEntry.latestDevPackage!;
            execSync(`git checkout --quiet ${loadedPackage.commitSha}`);

            const tag = `${loadedPackage.name}@dev`;

            const builtPackage = await tryBuildPackage(loadedPackage, buildCommand, {}).catch((err: Error) => {
                error(err);
                return null;
            });
            if (builtPackage === null) continue;

            let scriptName: string | undefined = undefined;
            let metaName: string | undefined = undefined;
            for (const [filename] of builtPackage.files) {
                if (filename.endsWith(".user.js")) scriptName = path.basename(filename);
                else if (filename.endsWith(".meta.js")) metaName = path.basename(filename);
            }

            const metadata: UserscriptMetadata = {};
            if (scriptName) metadata.downloadURL = downloadBase + tag + "/" + scriptName;
            if (metaName) metadata.updateURL = downloadBase + tag + "/" + metaName;

            const versionedBuiltPackage = await tryBuildPackage(loadedPackage, buildCommand, metadata);
            if (versionedBuiltPackage === null) continue;

            await publishTagAndRelease(octokit, context.repo.owner, context.repo.repo, loadedPackage.commitSha, tag, versionedBuiltPackage.files, true)
        }
    }

    execSync(`git checkout --quiet ${context.payload.after}`);
}

run().catch((err: Error) => {
    setFailed(err);
});
