import { $, write } from "bun";
import { afterAll, expect, test, describe } from "bun:test";
import {
  chmod,
  copyFile,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bookmarkHead, bookmarkHeadsForChange, bodyWithoutPrStack } from "./index";
import { closestBookmarkBeforeChangeRevset } from "./lib/pr-stack";
import { constructRevset, DEFAULT_LOG_REVSET } from "./lib/revset";
import { exec } from "./lib/exec";
import { TEST_JJ_CONFIG } from "./lib/config";

const bun = process.execPath;
const pathToIndexFile = join(import.meta.dirname, "index.ts");
const pathToFakeGh = join(import.meta.dirname, "test/fixtures/fake-gh.ts");
const jjconf = TEST_JJ_CONFIG;

async function makeTempDir(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "jj-pr-test-")));
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

  // The spawned index.ts uses PROD_JJ_CONFIG, which has no bookmark-prefix.
  // Pin it at the repo level so prefix resolution never falls back to the
  // machine-global `user.email` (absent in CI, which made tests fail there).
  await $`jj --config-file ${jjconf} config set --repo jj-pr.bookmark-prefix test/jj/`
    .cwd(repo)
    .quiet();
  // Repo-level identity for the same reason: when jj-pr itself rewrites
  // commits (the merged-ancestor rebase), a machine with no global jj config
  // would produce an empty committer, which `jj git push` refuses to push.
  await $`jj --config-file ${jjconf} config set --repo user.name ${"jj-pr tests"}`
    .cwd(repo)
    .quiet();
  await $`jj --config-file ${jjconf} config set --repo user.email jj-pr-tests@example.com`
    .cwd(repo)
    .quiet();

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

async function setupMasterBranch(repo: string) {
  await $`touch hello.txt`.cwd(repo);
  const jj = new JJ(repo);

  await $`jj --config-file ${jjconf} desc -m "add hello.txt"`
    .cwd(repo)
    .quiet();
  await jj.bookmark_create("@", "master").quiet();
  await $`jj --config-file ${jjconf} bookmark track master --remote=origin`
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

async function setupFakeGh(
  state: object = { nextNumber: 1, prs: [] },
): Promise<{ binDir: string; statePath: string }> {
  const root = await makeTempDir();
  cleanups.push(() => rm(root, { force: true, recursive: true }));

  const binDir = join(root, "bin");
  const statePath = join(root, "gh-state.json");
  const ghPath = join(binDir, "gh");

  await mkdir(binDir);
  await writeFile(statePath, JSON.stringify(state));
  await copyFile(pathToFakeGh, ghPath);
  await chmod(ghPath, 0o755);

  return { binDir, statePath };
}

/**
 * Builds a stack of two pushed changes on top of main, then abandons the top
 * one. Abandoning deletes the local bookmark but leaves
 * test/jj/generate-api-types@origin pointing at the now-hidden commit.
 */
async function setupAbandonedPushedChange(repo: string): Promise<void> {
  const jj = new JJ(repo);

  await writeFile(join(repo, "stream-flag.txt"), "stream\n");
  await jj.describe("@", "add stream flag");
  await jj.bookmark_create("@", "test/jj/add-stream-flag");
  await jj.git_push_bookmark("test/jj/add-stream-flag");

  await jj.new();
  await writeFile(join(repo, "api-types.txt"), "api types\n");
  await jj.describe("@", "generate api types");
  await jj.bookmark_create("@", "test/jj/generate-api-types");
  await jj.git_push_bookmark("test/jj/generate-api-types");

  await jj.new();
  await jj.exec("abandon test/jj/generate-api-types");
}

const logTemplate =
  'description.first_line() ++ " |>" ++ separate(",", local_bookmarks.map(|b| b.name()).join(", "), remote_bookmarks.map(|b| b.name() ++ "@" ++ b.remote()).join(",")) ++ "\n"';
async function logRevset(repo: string, revset: string): Promise<string> {
  return await $`jj --config-file ${jjconf} log --no-graph --reversed -r ${revset} -T ${logTemplate}`
    .cwd(repo)
    .text();
}

describe("bodyWithoutPrStack", () => {
  const stack = "## PR Stack\n- https://github.com/x/y/pull/1\n- `main`\n";

  test("strips stack when list immediately follows heading", () => {
    expect(bodyWithoutPrStack(`description\n\n${stack}`)).toBe(
      "description\n\n",
    );
  });

  test("strips stack when there is a blank line after the heading", () => {
    const stackWithBlankLine =
      "## PR Stack\n\n- https://github.com/x/y/pull/1\n- `main`\n";
    expect(bodyWithoutPrStack(`description\n\n${stackWithBlankLine}`)).toBe(
      "description\n\n",
    );
  });

  test("returns empty string when body is only the stack", () => {
    expect(bodyWithoutPrStack(stack)).toBe("");
  });

  test("returns body unchanged when there is no stack", () => {
    expect(bodyWithoutPrStack("just a description")).toBe(
      "just a description\n\n",
    );
  });

  test("strips stack when GitHub returns CRLF line endings", () => {
    const crlf =
      "description\r\n\r\n## PR Stack\r\n- https://github.com/x/y/pull/1\r\n- `main`\r\n";
    expect(bodyWithoutPrStack(crlf)).toBe("description\n\n");
  });

  test("strips every section when a body already has duplicates", () => {
    const doubled = `description\n\n${stack}\n${stack}`;
    expect(bodyWithoutPrStack(doubled)).toBe("description\n\n");
  });

  test("strips stack when the heading has trailing whitespace", () => {
    const trailing =
      "description\n\n## PR Stack \n- https://github.com/x/y/pull/1\n- `main`\n";
    expect(bodyWithoutPrStack(trailing)).toBe("description\n\n");
  });

  test("strips stack with multiple blank lines after the heading", () => {
    const blanks =
      "description\n\n## PR Stack\n\n\n- https://github.com/x/y/pull/1\n- `main`\n";
    expect(bodyWithoutPrStack(blanks)).toBe("description\n\n");
  });
});

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
  test("regression: excludes an abandoned change whose bookmark still exists on the remote", async () => {
    const { repo } = await setupTempJjRepo();
    await setupMainBranch(repo);
    await setupAbandonedPushedChange(repo);

    // the hidden abandoned commit is still pinned into the revset by
    // test/jj/generate-api-types@origin; its change ID is unresolvable by
    // later `jj log -r <change_id>` calls, so it must not be included here.
    expect(
      await logRevset(repo, `(${constructRevset("closest_pushable(@)")}) & mutable()`),
    ).toMatchInlineSnapshot(`
    "add stream flag |>test/jj/add-stream-flag,test/jj/add-stream-flag@git,test/jj/add-stream-flag@origin
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

  test("creates a PR based on another user's tracked branch with an existing PR", async () => {
    const { origin, repo } = await setupTempJjRepo();
    const jj = new JJ(repo);
    await setupMainBranch(repo);
    await createGitBranchWithDifferentCommitter(origin, "theirs");
    await jj.git_fetch();
    await $`jj --config-file ${jjconf} bookmark track theirs --remote=origin`
      .cwd(repo)
      .quiet();

    const authorEmail = (
      await $`jj --config-file ${jjconf} log -r theirs --no-graph -T 'author.email() ++ "\n"'`
        .cwd(repo)
        .text()
    ).trim();
    expect(authorEmail).toBe("other@example.com");

    await jj.new("theirs");
    await writeFile(join(repo, "ours.txt"), "ours\n");
    await jj.describe("@", "ours");
    await jj.new();

    const { binDir, statePath } = await setupFakeGh({
      nextNumber: 2,
      prs: [
        {
          number: 1,
          head: "theirs",
          title: "theirs",
          baseRefName: "main",
          body: "theirs body",
        },
      ],
    });
    const proc = Bun.spawn(["sh", "-c", 'yes "" | "$BUN_EXE" "$JJ_PR_INDEX"'], {
      cwd: repo,
      env: {
        ...process.env,
        BUN_EXE: bun,
        FAKE_GH_STATE: statePath,
        JJ_PR_INDEX: pathToIndexFile,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    expect(exitCode, `${stdout}\n${stderr}`).toBe(0);
    expect(stdout).toContain("New bookmarks:\ntest/jj/ours");
    expect(stdout).toContain("create these PRs:\ntest/jj/ours -> theirs");

    // The other user's PR is a rung of this stack, so it appears in the
    // stack section and its body gets the section written as well.
    const stackBody =
      "## PR Stack\n" +
      "- https://github.com/example/repo/pull/2\n" +
      "- https://github.com/example/repo/pull/1\n" +
      "- `main`\n";
    expect(stdout).toContain(stackBody);

    const ghState = JSON.parse(await readFile(statePath, "utf8"));
    expect(ghState.prs).toEqual([
      {
        number: 1,
        head: "theirs",
        title: "theirs",
        baseRefName: "main",
        body: `theirs body\n\n${stackBody}`,
      },
      {
        number: 2,
        head: "test/jj/ours",
        title: "ours",
        baseRefName: "theirs",
        body: stackBody,
      },
    ]);
  }, 15000);

  test("regression: approving a new bookmark also approves creating its PR", async () => {
    const { repo } = await setupTempJjRepo();
    const jj = new JJ(repo);
    await setupMainBranch(repo);

    await writeFile(join(repo, "feature.txt"), "feature\n");
    await jj.describe("@", "feature");
    await jj.new();

    const { binDir, statePath } = await setupFakeGh();
    const proc = Bun.spawn(["sh", "-c", 'yes "" | "$BUN_EXE" "$JJ_PR_INDEX"'], {
      cwd: repo,
      env: {
        ...process.env,
        BUN_EXE: bun,
        FAKE_GH_STATE: statePath,
        JJ_PR_INDEX: pathToIndexFile,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    expect(exitCode, `${stdout}\n${stderr}`).toBe(0);
    expect(stdout).toContain("New bookmarks:\ntest/jj/feature");
    expect(stdout).toContain("create these PRs:\ntest/jj/feature -> main");
    expect(stdout).not.toContain("update PRs?");

    const ghState = JSON.parse(await readFile(statePath, "utf8"));
    expect(ghState.prs).toEqual([
      {
        number: 1,
        head: "test/jj/feature",
        title: "feature",
        baseRefName: "main",
        body: "## PR Stack\n- https://github.com/example/repo/pull/1\n- `main`\n",
      },
    ]);
  }, 15000);

  test("uses the change description for a new PR's title and body", async () => {
    const { repo } = await setupTempJjRepo();
    const jj = new JJ(repo);
    await setupMainBranch(repo);

    await writeFile(join(repo, "feature.txt"), "feature\n");
    await jj.describe(
      "@",
      "add feature flag\n\nRolls out gradually.\nSee the runbook.",
    );
    await jj.new();

    const { binDir, statePath } = await setupFakeGh();
    const proc = Bun.spawn(["sh", "-c", 'yes "" | "$BUN_EXE" "$JJ_PR_INDEX"'], {
      cwd: repo,
      env: {
        ...process.env,
        BUN_EXE: bun,
        FAKE_GH_STATE: statePath,
        JJ_PR_INDEX: pathToIndexFile,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    expect(exitCode, `${stdout}\n${stderr}`).toBe(0);

    const ghState = JSON.parse(await readFile(statePath, "utf8"));
    expect(ghState.prs).toEqual([
      {
        number: 1,
        head: "test/jj/add-feature-flag",
        title: "add feature flag",
        baseRefName: "main",
        body:
          "Rolls out gradually.\nSee the runbook.\n\n" +
          "## PR Stack\n- https://github.com/example/repo/pull/1\n- `main`\n",
      },
    ]);
  }, 15000);

  test("regression: first run preserves existing PR stack entries when creating a top bookmark", async () => {
    const { repo } = await setupTempJjRepo();
    const jj = new JJ(repo);
    await setupMainBranch(repo);

    await writeFile(join(repo, "base-feature.txt"), "base\n");
    await jj.describe("@", "base feature");
    await jj.bookmark_create("@", "test/jj/base-feature");
    await jj.git_push_bookmark("test/jj/base-feature");

    await jj.new();
    await writeFile(join(repo, "middle-feature.txt"), "middle\n");
    await jj.describe("@", "middle feature");
    await jj.bookmark_create("@", "test/jj/middle-feature");
    await jj.git_push_bookmark("test/jj/middle-feature");

    await jj.new();
    await writeFile(join(repo, "top-feature.txt"), "top\n");
    await jj.describe("@", "top feature");
    await jj.new();

    const { binDir, statePath } = await setupFakeGh({
      nextNumber: 3,
      prs: [
        {
          number: 1,
          head: "test/jj/base-feature",
          title: "base feature",
          baseRefName: "main",
          body: "base body",
        },
        {
          number: 2,
          head: "test/jj/middle-feature",
          title: "middle feature",
          baseRefName: "test/jj/base-feature",
          body: "middle body",
        },
      ],
    });

    const proc = Bun.spawn(["sh", "-c", 'yes "" | "$BUN_EXE" "$JJ_PR_INDEX"'], {
      cwd: repo,
      env: {
        ...process.env,
        BUN_EXE: bun,
        FAKE_GH_STATE: statePath,
        JJ_PR_INDEX: pathToIndexFile,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    expect(exitCode, `${stdout}\n${stderr}`).toBe(0);
    expect(stdout).toContain("New bookmarks:\ntest/jj/top-feature");
    expect(stdout).toContain(
      "create these PRs:\ntest/jj/top-feature -> test/jj/middle-feature",
    );

    const stackBody =
      "## PR Stack\n" +
      "- https://github.com/example/repo/pull/3\n" +
      "- https://github.com/example/repo/pull/2\n" +
      "- https://github.com/example/repo/pull/1\n" +
      "- `main`\n";

    const ghState = JSON.parse(await readFile(statePath, "utf8"));
    expect(ghState.prs).toEqual([
      {
        number: 1,
        head: "test/jj/base-feature",
        title: "base feature",
        baseRefName: "main",
        body: `base body\n\n${stackBody}`,
      },
      {
        number: 2,
        head: "test/jj/middle-feature",
        title: "middle feature",
        baseRefName: "test/jj/base-feature",
        body: `middle body\n\n${stackBody}`,
      },
      {
        number: 3,
        head: "test/jj/top-feature",
        title: "top feature",
        baseRefName: "test/jj/middle-feature",
        body: stackBody,
      },
    ]);
  }, 15000);

  test("creates a PR for a hand-named local bookmark without requiring the prefix", async () => {
    const { repo } = await setupTempJjRepo();
    const jj = new JJ(repo);
    await setupMainBranch(repo);

    await writeFile(join(repo, "hotfix.txt"), "hotfix\n");
    await jj.describe("@", "hotfix login");
    await jj.bookmark_create("@", "hotfix-login");
    await jj.git_push_bookmark("hotfix-login");

    await jj.new();
    await writeFile(join(repo, "top.txt"), "top\n");
    await jj.describe("@", "top");
    await jj.new();

    const { binDir, statePath } = await setupFakeGh();

    const proc = Bun.spawn(["sh", "-c", 'yes "" | "$BUN_EXE" "$JJ_PR_INDEX"'], {
      cwd: repo,
      env: {
        ...process.env,
        BUN_EXE: bun,
        FAKE_GH_STATE: statePath,
        JJ_PR_INDEX: pathToIndexFile,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    expect(exitCode, `${stdout}\n${stderr}`).toBe(0);
    expect(stdout).toContain("New bookmarks:\ntest/jj/top");
    expect(stdout).toContain(
      "create these PRs:\nhotfix-login -> main\ntest/jj/top -> hotfix-login",
    );

    const stackBody =
      "## PR Stack\n" +
      "- https://github.com/example/repo/pull/2\n" +
      "- https://github.com/example/repo/pull/1\n" +
      "- `main`\n";

    const ghState = JSON.parse(await readFile(statePath, "utf8"));
    expect(ghState.prs).toEqual([
      {
        number: 1,
        head: "hotfix-login",
        title: "hotfix login",
        baseRefName: "main",
        body: stackBody,
      },
      {
        number: 2,
        head: "test/jj/top",
        title: "top",
        baseRefName: "hotfix-login",
        body: stackBody,
      },
    ]);
  }, 15000);

  test("keeps a remote-only bookmark with a PR as a stack rung when pushing a new bookmark", async () => {
    const { repo } = await setupTempJjRepo();
    const jj = new JJ(repo);
    await setupMainBranch(repo);

    await writeFile(join(repo, "shared.txt"), "shared\n");
    await jj.describe("@", "shared feature");
    await jj.bookmark_create("@", "shared/feature");
    await jj.git_push_bookmark("shared/feature");
    await jj.exec("bookmark delete shared/feature");

    await jj.new();
    await writeFile(join(repo, "top-feature.txt"), "top\n");
    await jj.describe("@", "top feature");
    await jj.new();

    const { binDir, statePath } = await setupFakeGh({
      nextNumber: 2,
      prs: [
        {
          number: 1,
          head: "shared/feature",
          title: "shared feature",
          baseRefName: "main",
          body: "shared body",
        },
      ],
    });

    const proc = Bun.spawn(["sh", "-c", 'yes "" | "$BUN_EXE" "$JJ_PR_INDEX"'], {
      cwd: repo,
      env: {
        ...process.env,
        BUN_EXE: bun,
        FAKE_GH_STATE: statePath,
        JJ_PR_INDEX: pathToIndexFile,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    expect(exitCode, `${stdout}\n${stderr}`).toBe(0);
    expect(stdout).toContain("New bookmarks:\ntest/jj/top-feature");
    expect(stdout).toContain("create these PRs:\ntest/jj/top-feature -> main");

    const stackBody =
      "## PR Stack\n" +
      "- https://github.com/example/repo/pull/2\n" +
      "- https://github.com/example/repo/pull/1\n" +
      "- `main`\n";

    const ghState = JSON.parse(await readFile(statePath, "utf8"));
    expect(ghState.prs).toEqual([
      {
        number: 1,
        head: "shared/feature",
        title: "shared feature",
        baseRefName: "main",
        body: `shared body\n\n${stackBody}`,
      },
      {
        number: 2,
        head: "test/jj/top-feature",
        title: "top feature",
        baseRefName: "main",
        body: stackBody,
      },
    ]);
  }, 15000);

  test("plans a fresh bookmark when a change's only bookmark is remote-only without a PR", async () => {
    const { repo } = await setupTempJjRepo();
    const jj = new JJ(repo);
    await setupMainBranch(repo);

    await writeFile(join(repo, "feature.txt"), "feature\n");
    await jj.describe("@", "feature");
    await jj.bookmark_create("@", "someone/stale");
    await jj.git_push_bookmark("someone/stale");
    await jj.exec("bookmark delete someone/stale");
    await jj.new();

    const { binDir, statePath } = await setupFakeGh();

    const result = await $`${bun} ${pathToIndexFile} --dry-run`
      .cwd(repo)
      .env({
        ...process.env,
        FAKE_GH_STATE: statePath,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
      })
      .nothrow()
      .quiet();

    const stdout = result.stdout.toString();
    const stderr = result.stderr.toString();
    expect(result.exitCode, `${stdout}\n${stderr}`).toBe(0);
    expect(stdout).toContain("New bookmarks:\ntest/jj/feature");
    expect(stdout).not.toContain("someone/stale ->");
  }, 15000);

  test("regression: bases a sibling of current main on main", async () => {
    const { repo } = await setupTempJjRepo();
    const jj = new JJ(repo);
    await setupMainBranch(repo);

    await jj.new("main");
    await writeFile(join(repo, "def234.txt"), "DEF234\n");
    await jj.describe("@", "DEF234");
    await $`jj --config-file ${jjconf} bookmark move main --to @`
      .cwd(repo)
      .quiet();
    await jj.git_push_bookmark("main");

    await jj.new("main-");
    await writeFile(join(repo, "efg345.txt"), "EFG345\n");
    await jj.describe("@", "klmnop");
    await jj.bookmark_create("@", "test/jj/klmnop");
    await jj.git_push_bookmark("test/jj/klmnop");
    await jj.new();

    const { binDir, statePath } = await setupFakeGh();

    const result = await $`${bun} ${pathToIndexFile} --dry-run`
      .cwd(repo)
      .env({
        ...process.env,
        FAKE_GH_STATE: statePath,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
      })
      .nothrow()
      .quiet();

    const stdout = result.stdout.toString();
    const stderr = result.stderr.toString();
    expect(result.exitCode, `${stdout}\n${stderr}`).toBe(0);
    expect(stdout).toContain("create these PRs:\ntest/jj/klmnop -> main");
    expect(stdout).toContain("## PR Stack\n- [new PR] test/jj/klmnop\n- `main`");
  }, 15000);

  test("regression: dry run succeeds after abandoning a change whose bookmark was pushed", async () => {
    const { repo } = await setupTempJjRepo();
    await setupMainBranch(repo);
    await setupAbandonedPushedChange(repo);

    const { binDir, statePath } = await setupFakeGh();

    const result = await $`${bun} ${pathToIndexFile} --dry-run`
      .cwd(repo)
      .env({
        ...process.env,
        FAKE_GH_STATE: statePath,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
      })
      .nothrow()
      .quiet();

    const stdout = result.stdout.toString();
    const stderr = result.stderr.toString();
    expect(result.exitCode, `${stdout}\n${stderr}`).toBe(0);
    expect(stdout).toContain(
      "create these PRs:\ntest/jj/add-stream-flag -> main",
    );
    expect(stdout).toContain(
      "## PR Stack\n- [new PR] test/jj/add-stream-flag\n- `main`",
    );
  }, 15000);

  test("regression: bases a feature on master when another PR bookmark also points at trunk", async () => {
    const { repo } = await setupTempJjRepo();
    const jj = new JJ(repo);
    await setupMasterBranch(repo);

    await jj.bookmark_create("master", "cursor/0f2f3935");
    await jj.new("master");
    await writeFile(join(repo, "feature.txt"), "feature\n");
    await jj.describe("@", "feature");
    await jj.bookmark_create("@", "test/jj/feature");
    await jj.git_push_bookmark("test/jj/feature");
    await jj.new();

    const { binDir, statePath } = await setupFakeGh({
      nextNumber: 2,
      prs: [
        {
          number: 1,
          head: "cursor/0f2f3935",
          title: "old cursor branch",
          baseRefName: "master",
          body: "old cursor body",
        },
      ],
    });

    const result = await $`${bun} ${pathToIndexFile} --dry-run`
      .cwd(repo)
      .env({
        ...process.env,
        FAKE_GH_STATE: statePath,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
      })
      .nothrow()
      .quiet();

    const stdout = result.stdout.toString();
    const stderr = result.stderr.toString();
    expect(result.exitCode, `${stdout}\n${stderr}`).toBe(0);
    expect(stdout).toContain("create these PRs:\ntest/jj/feature -> master");
    expect(stdout).toContain(
      "## PR Stack\n- [new PR] test/jj/feature\n- `master`",
    );
    expect(stdout).not.toContain("cursor/0f2f3935\nmaster");
  }, 15000);

  test("regression: bases a feature on master when another PR bookmark is an ancestor of master", async () => {
    const { repo } = await setupTempJjRepo();
    const jj = new JJ(repo);
    await setupMasterBranch(repo);

    await writeFile(join(repo, "old-cursor-branch.txt"), "old cursor branch\n");
    await jj.describe("@", "old cursor branch");
    await jj.bookmark_create("@", "cursor/0f2f3935");
    await jj.git_push_bookmark("cursor/0f2f3935");

    await jj.new("cursor/0f2f3935");
    await writeFile(join(repo, "advance-master.txt"), "advance master\n");
    await jj.describe("@", "advance master");
    await $`jj --config-file ${jjconf} bookmark move master --to @`
      .cwd(repo)
      .quiet();
    await jj.git_push_bookmark("master");

    await jj.new("cursor/0f2f3935");
    await writeFile(join(repo, "feature.txt"), "feature\n");
    await jj.describe("@", "feature");
    await jj.bookmark_create("@", "test/jj/feature");
    await jj.git_push_bookmark("test/jj/feature");
    await jj.new();

    const { binDir, statePath } = await setupFakeGh({
      nextNumber: 2,
      prs: [
        {
          number: 1,
          head: "cursor/0f2f3935",
          title: "old cursor branch",
          baseRefName: "master",
          body: "old cursor body",
        },
      ],
    });

    const result = await $`${bun} ${pathToIndexFile} --dry-run`
      .cwd(repo)
      .env({
        ...process.env,
        FAKE_GH_STATE: statePath,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
      })
      .nothrow()
      .quiet();

    const stdout = result.stdout.toString();
    const stderr = result.stderr.toString();
    expect(result.exitCode, `${stdout}\n${stderr}`).toBe(0);
    expect(stdout).toContain("create these PRs:\ntest/jj/feature -> master");
    expect(stdout).toContain(
      "## PR Stack\n- [new PR] test/jj/feature\n- `master`",
    );
  }, 15000);

  test("dry run plans PRs for unbookmarked changes without mutating GitHub", async () => {
    const { repo } = await setupTempJjRepo();
    const jj = new JJ(repo);
    await setupMainBranch(repo);

    await writeFile(join(repo, "feature.txt"), "feature\n");
    await jj.describe("@", "feature");
    await jj.new();

    const { binDir, statePath } = await setupFakeGh();

    const result = await $`${bun} ${pathToIndexFile} --dry-run`
      .cwd(repo)
      .env({
        ...process.env,
        FAKE_GH_STATE: statePath,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
      })
      .nothrow()
      .quiet();

    const stdout = result.stdout.toString();
    const stderr = result.stderr.toString();
    expect(result.exitCode, `${stdout}\n${stderr}`).toBe(0);
    expect(stdout).toContain("New bookmarks:\ntest/jj/feature");
    expect(stdout).toContain("create these PRs:\ntest/jj/feature -> main");
    expect(stdout).toContain("## PR Stack\n- [new PR] test/jj/feature\n- `main`");

    const ghState = JSON.parse(await readFile(statePath, "utf8"));
    expect(ghState.prs).toEqual([]);
    expect(
      ghState.commands.some(
        (command: string[]) =>
          command[0] === "pr" &&
          (command[1] === "create" || command[1] === "edit"),
      ),
    ).toBe(false);
  }, 15000);

  test("dry run bases a child PR on a planned bookmark for its unbookmarked parent", async () => {
    const { repo } = await setupTempJjRepo();
    const jj = new JJ(repo);
    await setupMainBranch(repo);

    await writeFile(join(repo, "middle.txt"), "middle\n");
    await jj.describe("@", "middle");
    const middleChange = (
      await $`jj --config-file ${jjconf} log -r @ --no-graph -T 'change_id ++ "\n"'`
        .cwd(repo)
        .text()
    ).trim();

    await jj.new();
    await writeFile(join(repo, "top.txt"), "top\n");
    await jj.describe("@", "top");
    await jj.bookmark_create("@", "test/jj/top");
    await jj.new();

    const { binDir, statePath } = await setupFakeGh();

    const result = await $`${bun} ${pathToIndexFile} --dry-run ${middleChange}`
      .cwd(repo)
      .env({
        ...process.env,
        FAKE_GH_STATE: statePath,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
      })
      .nothrow()
      .quiet();

    const stdout = result.stdout.toString();
    const stderr = result.stderr.toString();
    expect(result.exitCode, `${stdout}\n${stderr}`).toBe(0);
    expect(stdout).toContain("New bookmarks:\ntest/jj/middle");
    expect(stdout).toContain("test/jj/middle -> main");
    expect(stdout).toContain("test/jj/top -> test/jj/middle");
    expect(stdout).toContain(
      "## PR Stack\n- [new PR] test/jj/top\n- [new PR] test/jj/middle\n- `main`",
    );

    const ghState = JSON.parse(await readFile(statePath, "utf8"));
    expect(ghState.prs).toEqual([]);
  }, 15000);

  test("slugs new bookmark names from only the description's first line", async () => {
    const { repo } = await setupTempJjRepo();
    const jj = new JJ(repo);
    await setupMainBranch(repo);

    await writeFile(join(repo, "feature.txt"), "feature\n");
    await jj.describe(
      "@",
      "feature\n\nlonger body that must not leak into the bookmark name",
    );
    await jj.new();

    const { binDir, statePath } = await setupFakeGh();

    const result = await $`${bun} ${pathToIndexFile} --dry-run`
      .cwd(repo)
      .env({
        ...process.env,
        FAKE_GH_STATE: statePath,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
      })
      .nothrow()
      .quiet();

    const stdout = result.stdout.toString();
    const stderr = result.stderr.toString();
    expect(result.exitCode, `${stdout}\n${stderr}`).toBe(0);
    expect(stdout).toContain("New bookmarks:\ntest/jj/feature\n");
    expect(stdout).not.toContain("featurelonger");
  }, 15000);

  test("plans suffixed bookmark names when a slug is already taken", async () => {
    const { repo } = await setupTempJjRepo();
    const jj = new JJ(repo);
    await setupMainBranch(repo);

    // An unrelated change already owns the slug the stack below would pick.
    await jj.new("main");
    await writeFile(join(repo, "other.txt"), "other\n");
    await jj.describe("@", "other work");
    await jj.bookmark_create("@", "test/jj/feature");

    await jj.new("main");
    await writeFile(join(repo, "parent.txt"), "parent\n");
    await jj.describe("@", "feature");
    const parentChange = (
      await $`jj --config-file ${jjconf} log -r @ --no-graph -T 'change_id ++ "\n"'`
        .cwd(repo)
        .text()
    ).trim();

    await jj.new();
    await writeFile(join(repo, "child.txt"), "child\n");
    await jj.describe("@", "feature");
    const childChange = (
      await $`jj --config-file ${jjconf} log -r @ --no-graph -T 'change_id ++ "\n"'`
        .cwd(repo)
        .text()
    ).trim();
    await jj.new();

    const { binDir, statePath } = await setupFakeGh();

    const result =
      await $`${bun} ${pathToIndexFile} --dry-run -r ${`${parentChange}|${childChange}`}`
        .cwd(repo)
        .env({
          ...process.env,
          FAKE_GH_STATE: statePath,
          PATH: `${binDir}:${process.env.PATH ?? ""}`,
        })
        .nothrow()
        .quiet();

    const stdout = result.stdout.toString();
    const stderr = result.stderr.toString();
    expect(result.exitCode, `${stdout}\n${stderr}`).toBe(0);
    expect(stdout).toContain(
      "New bookmarks:\ntest/jj/feature-2\ntest/jj/feature-3",
    );
    expect(stdout).toContain(
      "create these PRs:\ntest/jj/feature-2 -> main\ntest/jj/feature-3 -> test/jj/feature-2",
    );
  }, 15000);

  test("pushes suffixed bookmarks for a stack of identically-described changes", async () => {
    const { repo } = await setupTempJjRepo();
    const jj = new JJ(repo);
    await setupMainBranch(repo);

    for (const file of ["fix1.txt", "fix2.txt", "fix3.txt"]) {
      await writeFile(join(repo, file), `${file}\n`);
      await jj.describe("@", "fix");
      await jj.new();
    }

    const { binDir, statePath } = await setupFakeGh();

    const proc = Bun.spawn(
      ["sh", "-c", 'yes "" | "$BUN_EXE" "$JJ_PR_INDEX" -r "main..@"'],
      {
        cwd: repo,
        env: {
          ...process.env,
          BUN_EXE: bun,
          FAKE_GH_STATE: statePath,
          JJ_PR_INDEX: pathToIndexFile,
          PATH: `${binDir}:${process.env.PATH ?? ""}`,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    expect(exitCode, `${stdout}\n${stderr}`).toBe(0);
    expect(stdout).toContain(
      "New bookmarks:\ntest/jj/fix\ntest/jj/fix-2\ntest/jj/fix-3",
    );
    expect(stdout).toContain(
      "create these PRs:\ntest/jj/fix -> main\ntest/jj/fix-2 -> test/jj/fix\ntest/jj/fix-3 -> test/jj/fix-2",
    );

    const stackBody =
      "## PR Stack\n" +
      "- https://github.com/example/repo/pull/3\n" +
      "- https://github.com/example/repo/pull/2\n" +
      "- https://github.com/example/repo/pull/1\n" +
      "- `main`\n";

    const ghState = JSON.parse(await readFile(statePath, "utf8"));
    expect(ghState.prs).toEqual([
      {
        number: 1,
        head: "test/jj/fix",
        title: "fix",
        baseRefName: "main",
        body: stackBody,
      },
      {
        number: 2,
        head: "test/jj/fix-2",
        title: "fix",
        baseRefName: "test/jj/fix",
        body: stackBody,
      },
      {
        number: 3,
        head: "test/jj/fix-3",
        title: "fix",
        baseRefName: "test/jj/fix-2",
        body: stackBody,
      },
    ]);
  }, 15000);

  test("dry run preserves every explicitly selected revision in a compound revset", async () => {
    const { repo } = await setupTempJjRepo();
    const jj = new JJ(repo);
    await setupMainBranch(repo);

    await writeFile(join(repo, "parent.txt"), "parent\n");
    await jj.describe("@", "parent");
    const parentChange = (
      await $`jj --config-file ${jjconf} log -r @ --no-graph -T 'change_id ++ "\n"'`
        .cwd(repo)
        .text()
    ).trim();

    await jj.new();
    await writeFile(join(repo, "child.txt"), "child\n");
    await jj.describe("@", "child");
    const childChange = (
      await $`jj --config-file ${jjconf} log -r @ --no-graph -T 'change_id ++ "\n"'`
        .cwd(repo)
        .text()
    ).trim();
    await jj.new();

    const { binDir, statePath } = await setupFakeGh();

    const result =
      await $`${bun} ${pathToIndexFile} --dry-run -r ${`${parentChange}|${childChange}`}`
        .cwd(repo)
        .env({
          ...process.env,
          FAKE_GH_STATE: statePath,
          PATH: `${binDir}:${process.env.PATH ?? ""}`,
        })
        .nothrow()
        .quiet();

    const stdout = result.stdout.toString();
    const stderr = result.stderr.toString();
    expect(result.exitCode, `${stdout}\n${stderr}`).toBe(0);
    expect(stdout).toContain("New bookmarks:\ntest/jj/parent\ntest/jj/child");
    expect(stdout).toContain("test/jj/parent -> main");
    expect(stdout).toContain("test/jj/child -> test/jj/parent");
    expect(stdout).toContain(
      "## PR Stack\n- [new PR] test/jj/child\n- [new PR] test/jj/parent\n- `main`",
    );

    const ghState = JSON.parse(await readFile(statePath, "utf8"));
    expect(ghState.prs).toEqual([]);
  }, 15000);

  test("exits cleanly if no stack", async () => {
    const { repo } = await setupTempJjRepo();
    await setupMainBranch(repo);
    const result = await $`${bun} ${pathToIndexFile}`.cwd(repo).nothrow();

    expect(result.exitCode).toBe(0);
    expect(result.stderr.toString()).toContain("nothing to do.");
    expect(result.stdout.toString()).toBe("");
  });
});

async function commitSha(repo: string, revset: string): Promise<string> {
  return (
    await $`jj --config-file ${jjconf} log --no-graph -r ${revset} -T commit_id`
      .cwd(repo)
      .text()
  ).trim();
}

async function firstLine(repo: string, revset: string): Promise<string> {
  return (
    await $`jj --config-file ${jjconf} log --no-graph -r ${revset} -T ${"description.first_line()"}`
      .cwd(repo)
      .text()
  ).trim();
}

async function remoteBranchSha(
  origin: string,
  branch: string,
): Promise<string> {
  const output = await $`git ls-remote ${origin} refs/heads/${branch}`.text();
  return output.split(/\s/)[0] ?? "";
}

/**
 * A two-PR stack (parent #1, child #2) pushed to origin, with the parent
 * squash-merged into main on the origin the way GitHub's merge button does:
 * main gains a single new commit "parent work (#1)" whose identity has no
 * link to the parent branch's commits.
 */
async function setupSquashMergedParent(options: {
  deleteBranch: boolean;
  middlePr?: boolean; // also stack + squash-merge a middle PR (#2)
}): Promise<{
  origin: string;
  repo: string;
  parentSha: string;
  middleSha?: string;
  childSha: string;
}> {
  const { origin, repo } = await setupTempJjRepo();
  const jj = new JJ(repo);
  await setupMainBranch(repo);

  await writeFile(join(repo, "parent.txt"), "parent\n");
  await jj.describe("@", "parent work");
  await jj.bookmark_create("@", "test/jj/parent-work");
  await jj.git_push_bookmark("test/jj/parent-work");

  let middleSha: string | undefined;
  if (options.middlePr) {
    await jj.new();
    await writeFile(join(repo, "middle.txt"), "middle\n");
    await jj.describe("@", "middle work");
    await jj.bookmark_create("@", "test/jj/middle-work");
    await jj.git_push_bookmark("test/jj/middle-work");
    middleSha = await commitSha(repo, "test/jj/middle-work");
  }

  await jj.new();
  await writeFile(join(repo, "child.txt"), "child\n");
  await jj.describe("@", "child work");
  await jj.bookmark_create("@", "test/jj/child-work");
  await jj.git_push_bookmark("test/jj/child-work");
  await jj.new();

  const parentSha = await commitSha(repo, "test/jj/parent-work");
  const childSha = await commitSha(repo, "test/jj/child-work");

  const clone = await makeTempDir();
  cleanups.push(() => rm(clone, { force: true, recursive: true }));
  await $`git clone --branch main ${origin} ${clone}`.quiet();
  const git = (...gitArgs: string[]) =>
    $`git -C ${clone} -c user.name=gh -c user.email=gh@example.com ${gitArgs}`.quiet();
  await git("merge", "--squash", "origin/test/jj/parent-work");
  await git("commit", "-m", "parent work (#1)");
  if (options.middlePr) {
    await git("merge", "--squash", "origin/test/jj/middle-work");
    await git("commit", "-m", "middle work (#2)");
  }
  await git("push", "origin", "main");
  if (options.deleteBranch) {
    await git("push", "origin", ":test/jj/parent-work");
    if (options.middlePr) {
      await git("push", "origin", ":test/jj/middle-work");
    }
  }

  return { origin, repo, parentSha, middleSha, childSha };
}

function runJjPr(repo: string, statePath: string, binDir: string) {
  return Bun.spawn(["sh", "-c", 'yes "" | "$BUN_EXE" "$JJ_PR_INDEX"'], {
    cwd: repo,
    env: {
      ...process.env,
      BUN_EXE: bun,
      FAKE_GH_STATE: statePath,
      JJ_PR_INDEX: pathToIndexFile,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
}

async function collect(proc: ReturnType<typeof Bun.spawn>) {
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout as ReadableStream).text(),
    new Response(proc.stderr as ReadableStream).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

describe("merged ancestor PRs", () => {
  const pull = (n: number) => `https://github.com/example/repo/pull/${n}`;

  test("rebases a stack stranded by a squash-merged parent (branch deleted)", async () => {
    const { origin, repo, parentSha, childSha } =
      await setupSquashMergedParent({ deleteBranch: true });

    const stackBefore = `## PR Stack\n- ${pull(2)}\n- ${pull(1)}\n- \`main\`\n`;
    const { binDir, statePath } = await setupFakeGh({
      nextNumber: 3,
      prs: [
        {
          number: 1,
          head: "test/jj/parent-work",
          title: "parent work",
          baseRefName: "main",
          body: "",
          state: "closed",
          mergedAt: "2026-07-07T00:00:00Z",
          headSha: parentSha,
        },
        {
          number: 2,
          head: "test/jj/child-work",
          title: "child work",
          baseRefName: "main", // auto-retargeted by GitHub on branch deletion
          body: `child body\n\n${stackBefore}`,
          headSha: childSha,
        },
      ],
    });

    const { stdout, stderr, exitCode } = await collect(
      runJjPr(repo, statePath, binDir),
    );

    expect(exitCode, `${stdout}\n${stderr}`).toBe(0);
    expect(stdout).toContain(
      `PR #1 (test/jj/parent-work) merged: $ jj rebase -s '${parentSha}+ & mutable()' -d 'trunk()'`,
    );

    // The child now sits directly on the squash commit...
    expect(await firstLine(repo, "test/jj/child-work-")).toBe(
      "parent work (#1)",
    );
    // ...and its new commit was pushed even though the pre-rebase preview
    // saw nothing to push.
    const rebasedSha = await commitSha(repo, "test/jj/child-work");
    expect(rebasedSha, `${stdout}\n${stderr}`).not.toBe(childSha);
    expect(
      await remoteBranchSha(origin, "test/jj/child-work"),
      `${stdout}\n${stderr}`,
    ).toBe(rebasedSha);

    // The merged parent moved below the trunk line in the stack section.
    const stackAfter = `## PR Stack\n- ${pull(2)}\n- \`main\`\n- ${pull(1)}\n`;
    const ghState = JSON.parse(await readFile(statePath, "utf8"));
    const childPr = ghState.prs.find(
      (pr: { number: number }) => pr.number === 2,
    );
    expect(childPr.body).toBe(`child body\n\n${stackAfter}`);
    expect(childPr.baseRefName).toBe("main");
  }, 30000);

  test("branch kept after merge: excludes the merged bookmark and retargets the child", async () => {
    const { origin, repo, parentSha, childSha } =
      await setupSquashMergedParent({ deleteBranch: false });

    const { binDir, statePath } = await setupFakeGh({
      nextNumber: 3,
      prs: [
        {
          number: 1,
          head: "test/jj/parent-work",
          title: "parent work",
          baseRefName: "main",
          body: "",
          state: "closed",
          mergedAt: "2026-07-07T00:00:00Z",
          headSha: parentSha,
        },
        {
          number: 2,
          head: "test/jj/child-work",
          title: "child work",
          baseRefName: "test/jj/parent-work", // no auto-retarget without deletion
          body: "",
          headSha: childSha,
        },
      ],
    });

    const { stdout, stderr, exitCode } = await collect(
      runJjPr(repo, statePath, binDir),
    );

    expect(exitCode, `${stdout}\n${stderr}`).toBe(0);
    // The merged bookmark must not be treated as a change to PR ("create")
    // nor as a base rung; the child's base moves to trunk.
    expect(stdout).not.toContain("create these PRs");
    expect(stdout).toContain("2 main (from test/jj/parent-work)");
    expect(stdout).toContain(`jj rebase -s '${parentSha}+ & mutable()'`);

    expect(await firstLine(repo, "test/jj/child-work-")).toBe(
      "parent work (#1)",
    );
    // The merged bookmark itself stays where it was, unpushed and untouched.
    expect(await commitSha(repo, "test/jj/parent-work")).toBe(parentSha);
    expect(await remoteBranchSha(origin, "test/jj/parent-work")).toBe(
      parentSha,
    );

    const ghState = JSON.parse(await readFile(statePath, "utf8"));
    const childPr = ghState.prs.find(
      (pr: { number: number }) => pr.number === 2,
    );
    expect(childPr.baseRefName).toBe("main");
  }, 30000);

  test("dry run logs the rebase but changes nothing", async () => {
    const { origin, repo, parentSha, childSha } =
      await setupSquashMergedParent({ deleteBranch: true });

    const { binDir, statePath } = await setupFakeGh({
      nextNumber: 3,
      prs: [
        {
          number: 1,
          head: "test/jj/parent-work",
          title: "parent work",
          baseRefName: "main",
          body: "",
          state: "closed",
          mergedAt: "2026-07-07T00:00:00Z",
          headSha: parentSha,
        },
        {
          number: 2,
          head: "test/jj/child-work",
          title: "child work",
          baseRefName: "main",
          body: `child body\n\n## PR Stack\n- ${pull(2)}\n- ${pull(1)}\n- \`main\`\n`,
          headSha: childSha,
        },
      ],
    });

    const run = () =>
      $`${bun} ${pathToIndexFile} --dry-run`
        .cwd(repo)
        .env({
          ...process.env,
          FAKE_GH_STATE: statePath,
          PATH: `${binDir}:${process.env.PATH ?? ""}`,
        })
        .nothrow()
        .quiet();

    const result = await run();
    const stdout = result.stdout.toString();
    expect(result.exitCode, `${stdout}\n${result.stderr.toString()}`).toBe(0);
    expect(stdout).toContain(
      `jj rebase -s '${parentSha}+ & mutable()' -d 'trunk()'`,
    );
    // The planned stack section already shows the merged parent in the tail.
    expect(stdout).toContain(`- ${pull(2)}\n- \`main\`\n- ${pull(1)}`);
    expect(stdout).toContain("would update description for PR #2");

    // Nothing moved: the child still sits on the stale local parent commit,
    // and the remote branch is untouched.
    expect(await firstLine(repo, "test/jj/child-work-")).toBe("parent work");
    expect(await commitSha(repo, "test/jj/child-work")).toBe(childSha);
    expect(await remoteBranchSha(origin, "test/jj/child-work")).toBe(childSha);

    const ghState = JSON.parse(await readFile(statePath, "utf8"));
    const mutating = ghState.commands.filter(
      (cmd: string[]) =>
        cmd[0] === "pr" && (cmd[1] === "edit" || cmd[1] === "create"),
    );
    expect(mutating).toEqual([]);
    expect(
      ghState.commands.some((cmd: string[]) => cmd[0] === "api"),
    ).toBe(true);

    // Repeated dry runs keep reporting the same plan.
    const again = await run();
    expect(again.stdout.toString()).toContain(
      `jj rebase -s '${parentSha}+ & mutable()' -d 'trunk()'`,
    );
  }, 30000);

  test("two stacked PRs merged at once: rebases from the tipmost merged head", async () => {
    const { repo, parentSha, middleSha, childSha } =
      await setupSquashMergedParent({ deleteBranch: true, middlePr: true });

    const stackBefore = `## PR Stack\n- ${pull(3)}\n- ${pull(2)}\n- ${pull(1)}\n- \`main\`\n`;
    const { binDir, statePath } = await setupFakeGh({
      nextNumber: 4,
      prs: [
        {
          number: 1,
          head: "test/jj/parent-work",
          title: "parent work",
          baseRefName: "main",
          body: "",
          state: "closed",
          mergedAt: "2026-07-07T00:00:00Z",
          headSha: parentSha,
        },
        {
          number: 2,
          head: "test/jj/middle-work",
          title: "middle work",
          baseRefName: "main",
          body: "",
          state: "closed",
          mergedAt: "2026-07-07T01:00:00Z",
          headSha: middleSha,
          commits: [parentSha, middleSha!],
        },
        {
          number: 3,
          head: "test/jj/child-work",
          title: "child work",
          baseRefName: "main",
          body: `child body\n\n${stackBefore}`,
          headSha: childSha,
        },
      ],
    });

    const { stdout, stderr, exitCode } = await collect(
      runJjPr(repo, statePath, binDir),
    );

    expect(exitCode, `${stdout}\n${stderr}`).toBe(0);
    // One rebase, from the tipmost merged head; the deeper merged PR's
    // commits stay behind (their content is in trunk).
    expect(stdout).toContain(`jj rebase -s '${middleSha}+ & mutable()'`);
    expect(stdout).not.toContain(`jj rebase -s '${parentSha}+`);

    expect(await firstLine(repo, "test/jj/child-work-")).toBe(
      "middle work (#2)",
    );

    // Both merged PRs land in the tail, newest merge first.
    const stackAfter = `## PR Stack\n- ${pull(3)}\n- \`main\`\n- ${pull(2)}\n- ${pull(1)}\n`;
    const ghState = JSON.parse(await readFile(statePath, "utf8"));
    const childPr = ghState.prs.find(
      (pr: { number: number }) => pr.number === 3,
    );
    expect(childPr.body).toBe(`child body\n\n${stackAfter}`);
  }, 30000);

  test("keeps a manually-rebased stack's merged parent in the section tail", async () => {
    const { repo, parentSha, childSha } = await setupSquashMergedParent({
      deleteBranch: true,
    });
    const jj = new JJ(repo);

    // The user already did the fix by hand before running jj-pr.
    await jj.git_fetch();
    await jj.exec(`rebase -s '${parentSha}+ & mutable()' -d 'trunk()'`);

    const stackBefore = `## PR Stack\n- ${pull(2)}\n- ${pull(1)}\n- \`main\`\n`;
    const { binDir, statePath } = await setupFakeGh({
      nextNumber: 3,
      prs: [
        {
          number: 1,
          head: "test/jj/parent-work",
          title: "parent work",
          baseRefName: "main",
          body: "",
          state: "closed",
          mergedAt: "2026-07-07T00:00:00Z",
          headSha: parentSha,
        },
        {
          number: 2,
          head: "test/jj/child-work",
          title: "child work",
          baseRefName: "main",
          body: `child body\n\n${stackBefore}`,
          headSha: childSha,
        },
      ],
    });

    const { stdout, stderr, exitCode } = await collect(
      runJjPr(repo, statePath, binDir),
    );

    expect(exitCode, `${stdout}\n${stderr}`).toBe(0);
    // Nothing to rebase -- but #1, displaced from the live stack, is
    // confirmed merged via gh pr view and kept below the trunk line.
    expect(stdout).not.toContain("jj rebase -s");
    const stackAfter = `## PR Stack\n- ${pull(2)}\n- \`main\`\n- ${pull(1)}\n`;
    const ghState = JSON.parse(await readFile(statePath, "utf8"));
    const childPr = ghState.prs.find(
      (pr: { number: number }) => pr.number === 2,
    );
    expect(childPr.body).toBe(`child body\n\n${stackAfter}`);
  }, 30000);

  test("closed-without-merge parent: no rebase, and it drops from the section", async () => {
    const { repo, parentSha, childSha } = await setupSquashMergedParent({
      deleteBranch: true,
    });

    const { binDir, statePath } = await setupFakeGh({
      nextNumber: 3,
      prs: [
        {
          number: 1,
          head: "test/jj/parent-work",
          title: "parent work",
          baseRefName: "main",
          body: "",
          state: "closed",
          mergedAt: null, // closed, not merged
          headSha: parentSha,
        },
        {
          number: 2,
          head: "test/jj/child-work",
          title: "child work",
          baseRefName: "main",
          body: `child body\n\n## PR Stack\n- ${pull(2)}\n- ${pull(1)}\n- \`main\`\n`,
          headSha: childSha,
        },
      ],
    });

    const result = await $`${bun} ${pathToIndexFile} --dry-run`
      .cwd(repo)
      .env({
        ...process.env,
        FAKE_GH_STATE: statePath,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
      })
      .nothrow()
      .quiet();

    const stdout = result.stdout.toString();
    expect(result.exitCode, `${stdout}\n${result.stderr.toString()}`).toBe(0);
    expect(stdout).not.toContain("jj rebase -s");
    // The closed PR is neither in the live stack nor carried in the tail.
    expect(stdout).toContain(`- ${pull(2)}\n- \`main\`\n`);
    expect(stdout).not.toContain(`- ${pull(1)}`);
  }, 30000);

  test("degrades to no rebase when the gh api call fails", async () => {
    const { repo, parentSha, childSha } = await setupSquashMergedParent({
      deleteBranch: true,
    });

    const { binDir, statePath } = await setupFakeGh({
      nextNumber: 3,
      failApi: true,
      prs: [
        {
          number: 1,
          head: "test/jj/parent-work",
          title: "parent work",
          baseRefName: "main",
          body: "",
          state: "closed",
          mergedAt: "2026-07-07T00:00:00Z",
          headSha: parentSha,
        },
        {
          number: 2,
          head: "test/jj/child-work",
          title: "child work",
          baseRefName: "main",
          body: "",
          headSha: childSha,
        },
      ],
    });

    const result = await $`${bun} ${pathToIndexFile} --dry-run`
      .cwd(repo)
      .env({
        ...process.env,
        FAKE_GH_STATE: statePath,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
      })
      .nothrow()
      .quiet();

    const stdout = result.stdout.toString();
    const stderr = result.stderr.toString();
    expect(result.exitCode, `${stdout}\n${stderr}`).toBe(0);
    expect(stderr).toContain("merged-PR detection skipped");
    expect(stdout).not.toContain("jj rebase -s");
  }, 30000);
});
