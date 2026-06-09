import { $, write } from "bun";
import { afterAll, expect, test, describe } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bookmarkHead, bookmarkHeadsForChange } from "./index";
import { closestBookmarkBeforeChangeRevset } from "./lib/pr-stack";
import { constructRevset, DEFAULT_LOG_REVSET } from "./lib/revset";
import { exec } from "./lib/exec";
import { TEST_JJ_CONFIG } from "./lib/config";

const bun = process.execPath;
const pathToIndexFile = join(import.meta.dirname, "index.ts");
const jjconf = TEST_JJ_CONFIG;

async function makeTempDir(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "jj-ts-test-")));
  return dir;
}

const cleanups: (() => Promise<void>)[] = [];

afterAll(async () => {
  await Promise.all(cleanups.map((fn) => fn()));
});

async function setupTempJjRepo(): Promise<{
  origin: string;
  repo: string;
}> {
  const root = await makeTempDir();
  const origin = join(root, "origin.git");
  const repo = join(root, "work");

  await $`git init --bare ${origin}`.quiet();
  await $`jj --config-file ${jjconf} git clone ${origin} ${repo}`.quiet();

  cleanups.push(() => rm(root, { force: true, recursive: true }));

  return {
    origin,
    repo,
  };
}

class JJ {
  path: string;

  constructor(repo: string) {
    this.path = repo;
  }
  exec(command: string) {
    return exec(`jj --config-file ${jjconf} ${command}`, { cwd: this.path });
  }

  describe(id: string, message: string) {
    return $`jj --config-file ${jjconf} describe -r ${id} -m ${message}`
      .cwd(this.path)
      .quiet();
  }

  bookmark_create(id: string, name: string) {
    return $`jj --config-file ${jjconf} bookmark create ${name} --revision ${id}`
      .cwd(this.path)
      .quiet();
  }

  git_push_bookmark(bookmark: string) {
    return $`jj --config-file ${jjconf} git push --bookmark ${bookmark}`
      .cwd(this.path)
      .quiet();
  }

  new(at: string | string[] = "@", edit = true) {
    if (Array.isArray(at)) {
      at = `-r ${at.join(" -r ")}`;
    }
    if (!edit) {
      return $`jj --config-file ${jjconf} new ${at} --no-edit`
        .cwd(this.path)
        .quiet();
    }
    return $`jj --config-file ${jjconf} new ${at}`.cwd(this.path).quiet();
  }

  log(revset?: string, template?: string) {
    return $`jj --config-file ${jjconf} log \
      --no-graph \
      --reversed \
      ${revset ? `-r ${revset}` : ""} \
      ${template ? `-T ${template}` : ""}`
      .cwd(this.path)
      .quiet()
      .text();
  }

  status() {
    return $`jj --config-file ${jjconf} status`.cwd(this.path).quiet();
  }
  git_fetch() {
    return $`jj --config-file ${jjconf} git fetch`.cwd(this.path).quiet();
  }
}

test("sets up a temporary jj repo with an origin", async () => {
  const { origin, repo } = await setupTempJjRepo();

  expect(
    (await $`jj --config-file ${jjconf} root`.cwd(repo).text()).trim(),
  ).toBe(repo);
  expect(
    (
      await $`jj --config-file ${jjconf} git remote list`.cwd(repo).text()
    ).trim(),
  ).toBe(`origin ${origin}`);
});

async function setupMainBranch(repo: string) {
  await $`touch hello.txt`.cwd(repo);
  const jj = new JJ(repo);

  const output = await $`jj --config-file ${jjconf} desc -m "add hello.txt"`
    .cwd(repo)
    .quiet();

  // (@) now at: kktxmksu
  const match = output.stderr.toString().match(/\(@\) now at:\s+(\S+)/);
  if (!match?.[1]) {
    throw new Error(
      `Unable to find working copy change ID in output:\n${output}`,
    );
  }
  const changeId = match[1];
  expect(changeId).toHaveLength(8);
  await jj.bookmark_create("@", "main").quiet();
  await $`jj --config-file ${jjconf} bookmark track main --remote=origin`
    .cwd(repo)
    .quiet();
  await jj.new().quiet();
  await $`jj --config-file ${jjconf} git push`.cwd(repo).quiet();
}

async function createGitBranchWithDifferentCommitter(
  origin: string,
  bookmark: string,
) {
  const clone = await makeTempDir();
  cleanups.push(() => rm(clone, { force: true, recursive: true }));

  await $`git clone --branch main ${origin} ${clone}`.quiet();
  await $`git checkout -b ${bookmark}`.cwd(clone).quiet();
  await writeFile(join(clone, `${bookmark}.txt`), `${bookmark}\n`);
  await $`git add ${`${bookmark}.txt`}`.cwd(clone).quiet();
  await $`git -c user.name="Other Contributor" -c user.email="other@example.com" commit -m ${bookmark}`
    .cwd(clone)
    .quiet();
  await $`git push origin ${bookmark}`.cwd(clone).quiet();
}

const logTemplate =
  'description.first_line() ++ " |>" ++ separate(",", local_bookmarks.map(|b| b.name()).join(", "), remote_bookmarks.map(|b| b.name() ++ "@" ++ b.remote()).join(",")) ++ "\n"';
async function logRevset(repo: string, revset: string): Promise<string> {
  return await $`jj --config-file ${jjconf} log --no-graph --reversed -r ${revset} -T ${logTemplate}`
    .cwd(repo)
    .text();
}

describe("bookmarkHead", () => {
  test("returns the bookmark unchanged when it has no remote", () => {
    expect(bookmarkHead("feature")).toBe("feature");
    expect(bookmarkHead("ta/jj/my-branch")).toBe("ta/jj/my-branch");
  });

  test("strips the remote suffix after the last @", () => {
    expect(bookmarkHead("feature@origin")).toBe("feature");
    expect(bookmarkHead("ta/jj/my-branch@origin")).toBe("ta/jj/my-branch");
  });
});

describe("bookmarkHeadsForChange", () => {
  async function withRepoCwd<T>(
    repo: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const originalCwd = process.cwd();
    try {
      process.chdir(repo);
      return await fn();
    } finally {
      process.chdir(originalCwd);
    }
  }

  test("returns an empty list when a change has no bookmarks", async () => {
    const { repo } = await setupTempJjRepo();
    const jj = new JJ(repo);
    await setupMainBranch(repo);
    await writeFile(join(repo, "unbookmarked.txt"), "unbookmarked\n");
    await jj.describe("@", "unbookmarked");

    const heads = await withRepoCwd(repo, () => bookmarkHeadsForChange("@"));
    expect(heads).toEqual([]);
  });

  test("returns unique local bookmark heads and drops remote suffixes", async () => {
    const { repo } = await setupTempJjRepo();
    const jj = new JJ(repo);
    await setupMainBranch(repo);
    await writeFile(join(repo, "feature.txt"), "feature\n");
    await jj.describe("@", "feature");
    await jj.bookmark_create("@", "feature");
    await jj.git_push_bookmark("feature");

    const heads = await withRepoCwd(repo, () => bookmarkHeadsForChange("@"));
    expect(heads).toEqual(["feature"]);
  });

  test("accepts revsets with parentheses such as closest_bookmark", async () => {
    const { repo } = await setupTempJjRepo();
    const jj = new JJ(repo);
    await setupMainBranch(repo);
    await writeFile(join(repo, "base.txt"), "base\n");
    await jj.describe("@", "base");
    await jj.bookmark_create("@", "ta/jj/base");
    await jj.new();
    await writeFile(join(repo, "child.txt"), "child\n");
    await jj.describe("@", "child");

    const changeId = (
      await $`jj --config-file ${jjconf} log -r @ --no-graph -T 'change_id ++ "\n"'`
        .cwd(repo)
        .text()
    ).trim();

    const heads = await withRepoCwd(repo, () =>
      bookmarkHeadsForChange(closestBookmarkBeforeChangeRevset(changeId)),
    );
    expect(heads).toEqual(["ta/jj/base"]);
  });

  test("returns multiple unique bookmark heads for one change", async () => {
    const { repo } = await setupTempJjRepo();
    const jj = new JJ(repo);
    await setupMainBranch(repo);
    await writeFile(join(repo, "feature.txt"), "feature\n");
    await jj.describe("@", "feature");
    await jj.bookmark_create("@", "feature");
    await jj.bookmark_create("@", "alternate");

    const heads = await withRepoCwd(repo, () => bookmarkHeadsForChange("@"));
    expect(heads).toHaveLength(2);
    expect(heads).toContain("feature");
    expect(heads).toContain("alternate");
  });
});

describe("constructRevset", () => {
  test("it selects the pushable parent when @ is on top of abc", async () => {
    const { repo } = await setupTempJjRepo();
    await setupMainBranch(repo);
    await writeFile(join(repo, "abc.txt"), "abc\n");
    await $`jj --config-file ${jjconf} desc -m abc`.cwd(repo).quiet();
    await $`jj --config-file ${jjconf} bookmark create abc --revision @`
      .cwd(repo)
      .quiet();
    await $`jj --config-file ${jjconf} new`.cwd(repo).quiet();
    expect(await logRevset(repo, DEFAULT_LOG_REVSET)).toMatchInlineSnapshot(`
    "add hello.txt |>main,main@git,main@origin
    abc |>abc,abc@git
     |>
    "
  `);

    expect(await logRevset(repo, constructRevset("abc")))
      .toMatchInlineSnapshot(`
    "abc |>abc,abc@git
    "
  `);
  });

  test("it includes bookmarked ancestors when a branch is requested", async () => {
    const { repo } = await setupTempJjRepo();
    const jj = new JJ(repo);
    await setupMainBranch(repo);
    const description = "def";
    await writeFile(join(repo, `${description}.txt`), `${description}\n`);
    await jj.describe("@", description);
    await jj.bookmark_create("@", description);
    await jj.new();
    await writeFile(join(repo, "abc.txt"), "abc\n");
    await jj.describe("@", "abc");
    await jj.bookmark_create("@", "abc");
    await $`jj --config-file ${jjconf} new def`.cwd(repo).quiet();
    await writeFile(join(repo, "current.txt"), "current\n");
    await $`jj --config-file ${jjconf} desc -m "current"`.cwd(repo).quiet();

    expect(await logRevset(repo, constructRevset("abc")))
      .toMatchInlineSnapshot(`
    "def |>def,def@git
    abc |>abc,abc@git
    "
  `);
  });

  test("it includes remote-bookmarked ancestors in a tree", async () => {
    const { repo } = await setupTempJjRepo();
    const jj = new JJ(repo);
    await setupMainBranch(repo);
    const description = "def";
    await writeFile(join(repo, `${description}.txt`), `${description}\n`);
    await jj.describe("@", description);
    await jj.bookmark_create("@", description);
    await $`jj --config-file ${jjconf} new`.cwd(repo).quiet();
    await writeFile(join(repo, "abc.txt"), "abc\n");
    await jj.describe("@", "abc");
    await jj.bookmark_create("@", "abc");
    await jj.git_push_bookmark("def");
    await jj.git_push_bookmark("abc");
    await $`jj --config-file ${jjconf} new def`.cwd(repo).quiet();
    await writeFile(join(repo, "current.txt"), "current\n");
    await $`jj --config-file ${jjconf} desc -m "current"`.cwd(repo).quiet();

    expect(await logRevset(repo, constructRevset("abc")))
      .toMatchInlineSnapshot(`
    "def |>def,def@git,def@origin
    abc |>abc,abc@git,abc@origin
    "
  `);
  });

  test("it includes local bookmarks in a stack", async () => {
    const { repo } = await setupTempJjRepo();
    const jj = new JJ(repo);
    await setupMainBranch(repo);
    await writeFile(join(repo, "def.txt"), "def\n");
    await jj.describe("@", "def");
    await jj.bookmark_create("@", "def");
    await jj.new();
    await writeFile(join(repo, "abc.txt"), "abc\n");
    await jj.describe("@", "abc");
    await jj.bookmark_create("@", "abc");
    await jj.git_push_bookmark("abc");
    await jj.new("def");
    await writeFile(join(repo, "current.txt"), "current\n");
    await jj.describe("@", "current");

    expect(await logRevset(repo, constructRevset("abc")))
      .toMatchInlineSnapshot(`
    "def |>def,def@git
    abc |>abc,abc@git,abc@origin
    "
  `);
  });

  test("regression: default revset includes the full bookmarked stack above a pushed base", async () => {
    const { repo } = await setupTempJjRepo();
    const jj = new JJ(repo);
    await setupMainBranch(repo);

    await writeFile(join(repo, "base.txt"), "base\n");
    await jj.describe("@", "convert runBash to streamBash");
    await jj.bookmark_create("@", "ta/jj/convert-runBash-to-streamBash");
    await jj.git_push_bookmark("ta/jj/convert-runBash-to-streamBash");

    await jj.new();
    await writeFile(join(repo, "middle.txt"), "middle\n");

    await jj.new();
    await writeFile(join(repo, "top.txt"), "top\n");
    await jj.describe("@", "add bash streaming endpoint to sandboxexec");
    await jj.bookmark_create(
      "@",
      "ta/jj/add-bash-streaming-endpoint-to-sandboxexec",
    );

    await jj.new();
    await writeFile(join(repo, "wip.txt"), "wip\n");
    await jj.describe("@", "bump sandbox image tag");
    await jj.bookmark_create("@", "ta/jj/wip");
    await jj.new();

    expect(await logRevset(repo, constructRevset("closest_pushable(@)")))
      .toMatchInlineSnapshot(`
    "convert runBash to streamBash |>ta/jj/convert-runBash-to-streamBash,ta/jj/convert-runBash-to-streamBash@git,ta/jj/convert-runBash-to-streamBash@origin
    "
  `);
  });
  test("both sides of a merge are included", async () => {
    const { repo } = await setupTempJjRepo();
    const jj = new JJ(repo);
    await setupMainBranch(repo);
    await writeFile(join(repo, "left.txt"), "left\n");
    await jj.describe("@", "left");
    await jj.bookmark_create("@", "left");
    await write(join(repo, "left.txt"), "left\n");
    await jj.git_push_bookmark("left");
    await jj.new("trunk()");
    await writeFile(join(repo, "right.txt"), "right\n");
    await jj.describe("@", "right");
    await jj.bookmark_create("@", "right");
    await write(join(repo, "right.txt"), "right\n");
    await jj.git_push_bookmark("right");
    await $`jj --config-file ${jjconf} new left right`.cwd(repo).quiet();
    await writeFile(join(repo, "merge.txt"), "merge\n");
    await jj.describe("@", "merge");
    await jj.bookmark_create("@", "merge");
    await jj.new();
    await writeFile(join(repo, "after-merge.txt"), "after-merge\n");
    await jj.describe("@", "after-merge");
    await jj.bookmark_create("@", "after-merge");
    await jj.new();

    expect(await logRevset(repo, constructRevset("after-merge")))
      .toMatchInlineSnapshot(`
    "left |>left,left@git,left@origin
    right |>right,right@git,right@origin
    merge |>merge,merge@git
    after-merge |>after-merge,after-merge@git
    "
  `);
    expect(await logRevset(repo, constructRevset("left")))
      .toMatchInlineSnapshot(`
        "left |>left,left@git,left@origin
        right |>right,right@git,right@origin
        merge |>merge,merge@git
        after-merge |>after-merge,after-merge@git
        "
        `);
    expect(await logRevset(repo, constructRevset("right")))
      .toMatchInlineSnapshot(`
        "left |>left,left@git,left@origin
        right |>right,right@git,right@origin
        merge |>merge,merge@git
        after-merge |>after-merge,after-merge@git
        "
        `);
  });

  test("it can model a local bookmarked change on someone else's branch", async () => {
    const { origin, repo } = await setupTempJjRepo();
    const jj = new JJ(repo);

    await setupMainBranch(repo);
    await createGitBranchWithDifferentCommitter(origin, "theirs");
    await jj.git_fetch();
    await jj.new("theirs@origin");

    const description = "ours";

    await writeFile(join(repo, `${description}.txt`), `${description}\n`);
    await jj.describe("@", description);
    await jj.bookmark_create("@", description);
    await jj.new();
    expect(await jj.log(constructRevset("ours"), logTemplate))
      .toMatchInlineSnapshot(`
        "theirs |>theirs@origin
        ours |>ours,ours@git
        "
        `);
  });
});

describe("main", () => {
  test("throws when no trunk bookmark is found", async () => {
    const { repo } = await setupTempJjRepo();
    const result = await $`${bun} ${pathToIndexFile}`
      .cwd(repo)
      .nothrow()
      .quiet();

    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("Unable to find trunk bookmark");
  });

  test("exits cleanly if no stack", async () => {
    const { repo } = await setupTempJjRepo();
    await setupMainBranch(repo);
    const result = await $`${bun} ${pathToIndexFile}`.cwd(repo).nothrow();

    expect(result.exitCode).toBe(0);
    expect(result.stderr.toString()).toContain("nothing to do.");
    expect(result.stdout.toString()).toBe("");
  });
});
