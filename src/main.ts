import { getInput, info, setFailed } from "@actions/core";
import { context, getOctokit } from "@actions/github";
import { glob } from "glob";
import { execSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import * as path from "node:path";

async function run(): Promise<void> {
    try {
        const token = process.env.GITHUB_TOKEN;
        if (token === undefined) throw Error("Token was undefined for some reason.");

        const octokit = getOctokit(token);
        const userscriptsDirectory = getInput("userscripts-dir", { required: true });
        const userscriptDirectories = (await readdir(userscriptsDirectory, { withFileTypes: true }))
            .filter((d) => d.isDirectory())
            .map((d) => d.name);
        for (const dirName of userscriptDirectories) {
            const userscriptDirectory = path.join(userscriptsDirectory, dirName);
            const packagePath = path.join(userscriptDirectory, "package.json");
            const packageRaw = await readFile(packagePath,  { encoding: "utf-8" });
            const packageJson = JSON.parse(packageRaw);

            if (typeof packageJson !== "object" || packageJson === null) throw Error(packagePath + " was not an object!");

            if (!("name" in packageJson)) throw Error(`package.json did not have a "name" property!`);
            const { name } = packageJson;
            if (typeof name !== "string") throw Error(`package.json "name" property was not a string!`);

            if (!("version" in packageJson)) throw Error(`package.json did not have a "versoin" property!`);
            const { version } = packageJson;
            if (typeof version !== "string") throw Error(`package.json "version" property was not a string!`);

            if (!("files" in packageJson)) throw Error(`package.json did not have a "files" property!`);
            const { files: filesArray } = packageJson;
            if (!Array.isArray(filesArray)) throw Error(`package.json "files" proprety was not an array!`);
            if (!filesArray.every((v) => typeof v === "string")) throw Error(`package.json "files" array was not all strings!`);

            const fileNames = await glob(filesArray, { cwd: userscriptDirectory, ignore: [
                "*.orig",
                ".*.swp",
                ".DS_Store",
                "._*",
                ".git",
                ".hg",
                ".lock-wscript",
                ".npmrc",
                ".svn",
                ".wafpickle-N",
                "CVS",
                "config.gypi",
                "node_modules",
                "npm-debug.log",
                "package-lock.json",
                "pnpm-lock.yaml",
                "yarn.lock",
                "bun.lockb",
                ".git",
                ".npmrc",
                "node_modules",
                "package-lock.json",
                "pnpm-lock.yaml",
                "yarn.lock",
                "bun.lockb"
            ]});

            const files = await Promise.all(fileNames.map<Promise<[string, string]>>(async (fileName) => ([path.basename(fileName), await readFile(path.join(userscriptDirectory, fileName), { encoding: "utf-8" })])));

            const tag = name + "@" + version;

            if (execSync(`git tag -l "${tag}"`).toString() !== "") continue;

            try {
                execSync(`git tag ${tag}`);
                execSync(`git push origin ${tag}`);
            } catch (err) {
                info(`There was some error pushing or setting the tag????`);
            }

            const latest = name + "@latest";

            const { owner, repo } = context.repo;

            try {
                const existingLatestRelease = await octokit.rest.repos.getReleaseByTag({
                    owner,
                    repo,
                    tag: latest
                });

                await octokit.rest.repos.deleteRelease({
                    owner,
                    repo,
                    release_id: existingLatestRelease.data.id
                });
            } catch {}

            try {
                execSync(`git tag -f ${latest}`);
                execSync(`git push origin -f ${latest}`);
            } catch (err) {
                info(`Failed to update latest tag: ${err}`);
            }

            const createRelease = async function(tagName: string) {
                const release = await octokit.rest.repos.createRelease({
                    owner,
                    repo,
                    tag_name: tagName,
                    name: tagName,
                    draft: false,
                    prerelease: false,
                    make_latest: "false"
                });

                await Promise.all(files.map(async ([fileName, file]) => await octokit.rest.repos.uploadReleaseAsset({
                    owner,
                    repo,
                    release_id: release.data.id,
                    name: fileName,
                    data: file
                })));
            }

            await Promise.all([latest, tag].map((tagName) => createRelease(tagName)))
        }
    } catch (error) {
        setFailed((error as Error)?.message ?? error);
    }
}

run();
