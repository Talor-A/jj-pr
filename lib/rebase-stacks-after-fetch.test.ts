import { $ } from "bun";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  findAbandonedBookmarksSince,
  getCurrentOperationId,
  resolveRebaseCheckpoint,
  stackRootsAbove,
} from "./rebase-stacks-after-fetch";
import { loadRebaseState, saveRebaseState } from "./rebase-state";
import { TEST_JJ_CONFIG } from "./config";

const jjconf = TEST_JJ_CONFIG;

const cleanups: (() => Promise<void>)[] = [];

afterAll(async () => {
  await Promise.all(cleanups.map((fn) => fn()));
});

async function makeTempDir(): Promise<string> {
  return realpath(await mkdtemp(join(tmpdir(), "jj-rebase-test-")));
}

async function setupTempJjRepo(): Promise<{ repo: string }> {
  const root = await makeTempDir();
  const origin = join(root, "origin.git");
  const repo = join(root, "work");

  await $`git init --bare ${origin}`.quiet();
  await $`jj --config-file ${jjconf} git clone ${origin} ${repo}`.quiet();
  cleanups.push(() => rm(root, { force: true, recursive: true }));

  return { repo };
}

async function setupMainBranch(repo: string) {
  await writeFile(join(repo, "hello.txt"), "hello\n");
  await $`jj --config-file ${jjconf} desc -m "add hello.txt"`.cwd(repo).quiet();
  await $`jj --config-file ${jjconf} bookmark create main --revision @`
    .cwd(repo)
    .quiet();
  await $`jj --config-file ${jjconf} bookmark track main --remote=origin`
    .cwd(repo)
    .quiet();
  await $`jj --config-file ${jjconf} new`.cwd(repo).quiet();
  await $`jj --config-file ${jjconf} git push`.cwd(repo).quiet();
}

async function logField(
  repo: string,
  revset: string,
  template: string,
): Promise<string> {
  return (
    await $`jj --config-file ${jjconf} log -r ${revset} --no-graph -T ${template}`
      .cwd(repo)
      .text()
  ).trim();
}

async function withRepoCwd<T>(repo: string, fn: () => Promise<T>): Promise<T> {
  const originalCwd = process.cwd();
  try {
    process.chdir(repo);
    return await fn();
  } finally {
    process.chdir(originalCwd);
  }
}

describe("resolveRebaseCheckpoint", () => {
  test("returns no diff on first run", () => {
    expect(
      resolveRebaseCheckpoint(null, "current", ["current", "older"]),
    ).toEqual({ beforeOp: null, stalePointer: false });
  });

  test("returns no diff when checkpoint equals current op", () => {
    expect(
      resolveRebaseCheckpoint("current", "current", ["current", "older"]),
    ).toEqual({ beforeOp: null, stalePointer: false });
  });

  test("uses the saved op as the before snapshot", () => {
    expect(
      resolveRebaseCheckpoint("older", "current", ["current", "older"]),
    ).toEqual({ beforeOp: "older", stalePointer: false });
  });

  test("marks pointer stale after op restore beyond history", () => {
    expect(
      resolveRebaseCheckpoint("missing", "current", ["current", "older"]),
    ).toEqual({ beforeOp: null, stalePointer: true });
  });
});

describe("stackRootsAbove", () => {
  test("regression: root is the unbookmarked bottom commit when only the top has a bookmark", async () => {
    const { repo } = await setupTempJjRepo();
    await setupMainBranch(repo);

    await writeFile(join(repo, "bottom.txt"), "bottom\n");
    await $`jj --config-file ${jjconf} desc -m bottom`.cwd(repo).quiet();
    await $`jj --config-file ${jjconf} bookmark create ta/jj/bottom --revision @`
      .cwd(repo)
      .quiet();
    const bottomCommitId = await logField(repo, "@", "commit_id");

    await $`jj --config-file ${jjconf} new`.cwd(repo).quiet();
    await writeFile(join(repo, "middle.txt"), "middle\n");
    await $`jj --config-file ${jjconf} desc -m middle`.cwd(repo).quiet();
    const middleChangeId = await logField(repo, "@", "change_id");

    await $`jj --config-file ${jjconf} new`.cwd(repo).quiet();
    await writeFile(join(repo, "top.txt"), "top\n");
    await $`jj --config-file ${jjconf} desc -m top`.cwd(repo).quiet();
    await $`jj --config-file ${jjconf} bookmark create ta/jj/top --revision @`
      .cwd(repo)
      .quiet();
    const topChangeId = await logField(repo, "@", "change_id");

    const roots = await withRepoCwd(repo, () =>
      stackRootsAbove(bottomCommitId),
    );

    expect(roots).toEqual([middleChangeId]);
    expect(roots).not.toContain(topChangeId);
  });
});

describe("findAbandonedBookmarksSince", () => {
  test("detects bookmarks deleted after the saved checkpoint", async () => {
    const { repo } = await setupTempJjRepo();
    await setupMainBranch(repo);

    await writeFile(join(repo, "feature.txt"), "feature\n");
    await $`jj --config-file ${jjconf} desc -m feature`.cwd(repo).quiet();
    await $`jj --config-file ${jjconf} bookmark create ta/jj/feature --revision @`
      .cwd(repo)
      .quiet();
    const commitId = await logField(repo, "@", "commit_id");

    const checkpointOp = await withRepoCwd(repo, () => getCurrentOperationId());
    const gitDir = (
      await $`git rev-parse --absolute-git-dir`.cwd(repo).text()
    ).trim();
    await saveRebaseState(gitDir, checkpointOp);

    await $`jj --config-file ${jjconf} bookmark delete ta/jj/feature`
      .cwd(repo)
      .quiet();

    const result = await withRepoCwd(repo, () =>
      findAbandonedBookmarksSince(checkpointOp),
    );

    expect(result.abandoned).toEqual([
      { name: "ta/jj/feature", previousCommit: commitId },
    ]);
    expect(result.stalePointer).toBe(false);
  });

  test("returns nothing on first run without a checkpoint", async () => {
    const { repo } = await setupTempJjRepo();
    await setupMainBranch(repo);

    const result = await withRepoCwd(repo, () =>
      findAbandonedBookmarksSince(null),
    );

    expect(result.abandoned).toEqual([]);
    expect(result.stalePointer).toBe(false);
  });

  test("regression: detects abandonment outside the latest fetch op", async () => {
    const { repo } = await setupTempJjRepo();
    await setupMainBranch(repo);

    await writeFile(join(repo, "feature.txt"), "feature\n");
    await $`jj --config-file ${jjconf} desc -m feature`.cwd(repo).quiet();
    await $`jj --config-file ${jjconf} bookmark create ta/jj/feature --revision @`
      .cwd(repo)
      .quiet();

    const checkpointOp = await withRepoCwd(repo, () => getCurrentOperationId());
    const gitDir = (
      await $`git rev-parse --absolute-git-dir`.cwd(repo).text()
    ).trim();
    await saveRebaseState(gitDir, checkpointOp);

    await $`jj --config-file ${jjconf} bookmark delete ta/jj/feature`
      .cwd(repo)
      .quiet();
    await $`jj --config-file ${jjconf} desc -m "unrelated follow-up"`
      .cwd(repo)
      .quiet();

    const state = await loadRebaseState(gitDir);
    const result = await withRepoCwd(repo, () =>
      findAbandonedBookmarksSince(state!.lastCheckedOp),
    );

    expect(result.abandoned.map((item) => item.name)).toEqual([
      "ta/jj/feature",
    ]);
  });
});
