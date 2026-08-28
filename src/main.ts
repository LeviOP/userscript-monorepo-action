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

async function getPotentialPackageDirs(userscriptsDirectory: string): Promise<string[]> {
    return (await readdir(userscriptsDirectory, { withFileTypes: true }))
        .filter((dirent) => dirent.isDirectory())
        .map((dirent) => dirent.name);
}

interface LoadedPackage {
    name: string;
    version: string;
    files: [fileName: string, content: string][];
    outputHash: string;
    commitSha: string;
}

async function tryLoadPackage(userscriptsDir: string, dirName: string, commitSha: string): Promise<LoadedPackage | null> {
    const dir = path.join(userscriptsDir, dirName);
    const packagePath = path.join(dir, "package.json");

    let packageRaw: string;
    try {
        packageRaw = await readFile(packagePath, { encoding: "utf-8" });
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
    const { files: filesArray } = packageJson;
    if (!Array.isArray(filesArray)) throw Error(`${packagePath} "files" property was not an array!`);
    if (!filesArray.every((v) => typeof v === "string")) throw Error(`${packagePath} "files" array was not all strings!`);

    const fileNames = await glob(filesArray, { cwd: dir });

    const files = await Promise.all(
        fileNames.map<Promise<[string, string]>>(async (fileName) => [
            path.basename(fileName),
            await readFile(path.join(dir, fileName), { encoding: "utf-8" }),
        ]),
    );

    const hash = createHash("sha256");
    for (const [fileName, content] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
        hash.update(fileName);
        hash.update("\0");
        hash.update(content);
        hash.update("\0");
    }

    return { name, version, files, outputHash: hash.digest("hex"), commitSha };
}

async function publishTagAndRelease(
    octokit: ReturnType<typeof getOctokit>,
    owner: string,
    repo: string,
    sha: string,
    tagName: string,
    files: [string, string][],
    forceMoveTag: boolean,
) {
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
                name: fileName,
                data: content,
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

async function run() {
    if (context.eventName !== "push") throw Error(`userscript-monorepo-action expects to be run on 'push' event! (got ${context.eventName})`);

    const token = getInput("token");
    const octokit = getOctokit(token);

    const userscriptsDirectory = getInput("userscripts-dir", { required: true });
    const buildCommand = getInput("build-command");

    const commits = context.payload.commits as Commit[];
    if (commits.length === 0) {
        info("No commits in this push. Nothing to do.");
        return;
    }

    info(`Analyzing ${commits.length} commits`);

    const commitShas = commits.map(commit => commit.id);

    const before = context.payload.before;

    const state: Record<string, PackageState> = {};

    if (before !== EMPTY_BEFORE_SHA) {
        info("Checkout out commit before push");
        execSync(`git fetch --depth=1 origin ${before}`);
        execSync(`git checkout --quiet ${before}`);
        try {
            info("Running build command");
            execSync(buildCommand);
        } catch (e) {
            const error = e as Error & SpawnSyncReturns<Buffer>;
            throw Error([
                `Error executing build command: ${error.message}`,
                error.stdout.toString(),
                error.stderr.toString(),
            ].filter(Boolean).join("\n"));
        }

        for (const dirname of await getPotentialPackageDirs(userscriptsDirectory)) {
            const loadedPackage = await tryLoadPackage(userscriptsDirectory, dirname, before).catch((err: Error) => {
                error(err);
                return null;
            });
            if (loadedPackage === null) continue;

            info(`Loading package "${loadedPackage.name}"`);

            state[loadedPackage.name] = {
                lastVersion: loadedPackage.version,
                versionHasChanged: false,
                lastOutputHash: loadedPackage.outputHash,
                hashHasChanged: false,
            };
        }
    }

    for (const commitSha of commitShas) {
        info(`Checking out ${commitSha}`);
        execSync(`git fetch --depth=1 origin ${commitSha}`);
        execSync(`git checkout --quiet ${commitSha}`);
        try {
            info("Running build command");
            execSync(buildCommand);
        } catch (e) {
            const error = e as Error & SpawnSyncReturns<Buffer>;
            throw Error([
                `Error executing build command: ${error.message}`,
                error.stdout.toString(),
                error.stderr.toString(),
            ].filter(Boolean).join("\n"));
        }

        for (const dirname of await getPotentialPackageDirs(userscriptsDirectory)) {
            const loadedPackage = await tryLoadPackage(userscriptsDirectory, dirname, commitSha).catch((err: Error) => {
                error(err);
                return null;
            });
            if (loadedPackage === null) continue;

            let packageEntry = state[loadedPackage.name];
            if (packageEntry === undefined) {
                packageEntry = state[loadedPackage.name] = { lastVersion: null, versionHasChanged: false, lastOutputHash: null, hashHasChanged: false };
            }

            info(`Analyzing package "${loadedPackage.name}"`);

            if (loadedPackage.outputHash !== packageEntry.lastOutputHash) {
                packageEntry.hashHasChanged = true;
                packageEntry.latestDevPackage = loadedPackage;
            }

            if (loadedPackage.version !== packageEntry.lastVersion) {
                // TODO: what if it's a lower (or already existing) version string?
                const tag = `${loadedPackage.name}@${loadedPackage.version}`;
                await publishTagAndRelease(octokit, context.repo.owner, context.repo.repo, commitSha, tag, loadedPackage.files, false);
                packageEntry.versionHasChanged = true;
                packageEntry.latestVersionedPackage = loadedPackage;
            }

            packageEntry.lastVersion = loadedPackage.version;
            packageEntry.lastOutputHash = loadedPackage.outputHash;
        }
    }

    for (const packageEntry of Object.values(state)) {
        if (packageEntry.versionHasChanged) {
            const loadedPackage = packageEntry.latestVersionedPackage!;
            const tag = `${loadedPackage.name}@latest`;
            await publishTagAndRelease(octokit, context.repo.owner, context.repo.repo, loadedPackage.commitSha, tag, loadedPackage.files, true)
        }
        if (packageEntry.hashHasChanged) {
            const loadedPackage = packageEntry.latestDevPackage!;
            const tag = `${loadedPackage.name}@dev`;
            await publishTagAndRelease(octokit, context.repo.owner, context.repo.repo, loadedPackage.commitSha, tag, loadedPackage.files, true)
        }
    }

    execSync(`git checkout --quiet ${context.payload.after}`);
}

run().catch((err: Error) => {
    setFailed(err);
});
