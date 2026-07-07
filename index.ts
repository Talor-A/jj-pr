#!/usr/bin/env node
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { z } from "zod";
import { constructRevset } from "./lib/revset";
import ora, { type Ora } from "ora";
import { join } from "node:path";
import {
  combineStdoutAndStderr,
  exec,
  execToSchema,
  execWithStdin,
  mapToStdout,
  shellQuote,
  succeeds,
} from "./lib/exec";
import { help, parseCli, type CliArgs } from "./lib/args";
import { completionScript, isShell, SHELLS } from "./lib/completion";
import {
  findAbandonedBookmarksSince,
  planRebasesFromAbandoned,
  saveRebaseCheckpoint,
  type RebasePlan,
} from "./lib/rebase-stacks-after-fetch";
import { absoluteGitDir, loadRebaseState } from "./lib/rebase-state";
import {
  existingBookmarkResults,
  jjLogBookmarksCommand,
  mergeBookmarkResults,
  proposedBookmarkRevset,
  type BookmarkResult,
  type BookmarkResultWithHead,
} from "./lib/pr-stack";
import {
  JJLogItemJsonSchema,
  PullRequestListSchema,
  PullRequestSchema,
  RepoSchema,
  type PullRequest,
} from "./lib/schema";
import { PROD_JJ_CONFIG } from "./lib/config";

const jjconf = PROD_JJ_CONFIG;

let _bookmarkPrefix: string | undefined;
// Resolved bookmark prefix for newly-created bookmarks. Prefers the
// `jj-pr.bookmark-prefix` config key (layered from the user's jj config),
// falling back to `<user>/jj/` derived from `user.email`.
async function getBookmarkPrefix(): Promise<string> {
  if (_bookmarkPrefix !== undefined) return _bookmarkPrefix;

  const configured = await exec(
    `jj --config-file ${jjconf} config get jj-pr.bookmark-prefix`,
  )
    .then(mapToStdout)
    .then((s) => s.trim())
    .catch(() => ""); // key unset -> jj exits non-zero

  let prefix = configured;
  if (!prefix) {
    const email = await exec(`jj --config-file ${jjconf} config get user.email`)
      .then(mapToStdout)
      .then((s) => s.trim())
      .catch(() => "");
    const user = email.split("@")[0];
    if (!user) {
      throw new Error(
        "Cannot determine a bookmark prefix: set `jj-pr.bookmark-prefix` " +
          "or `user.email` in your jj config.",
      );
    }
    prefix = `${user}/jj/`;
  }

  // Normalize so both "ta/jj" and "ta/jj/" work.
  _bookmarkPrefix = prefix.endsWith("/") ? prefix : `${prefix}/`;
  return _bookmarkPrefix;
}

// Matches a generated "## PR Stack" section and the bullet list that follows.
// Global so every prior section is stripped (a body that already accumulated
// duplicates self-heals), and tolerant of trailing heading whitespace and
// extra blank lines after the heading. Bodies are normalized to LF before this
// runs (see bodyWithoutPrStack), since GitHub returns PR bodies with CRLF.
const PR_STACK_SECTION_PATTERN =
  /(?:^|\n)(?:<!-- GENERATED_PR_STACK -->\n)?## PR Stack[ \t]*\n\n*(?:- .+(?:\n|$))+/gm;

async function confirm(
  message: string = "proceed? (⏎ / n)",
  /** @default true */
  acceptEmpty: boolean = true,
): Promise<boolean> {
  const rl = createInterface({ input: stdin, output: stdout });
  const reply = await rl.question(`${message} `);
  rl.close();
  if (reply === "") return acceptEmpty;
  return /^[Yy]/.test(reply);
}

function lines(value: string): string[] {
  return value.split(/\r?\n/).filter((line) => line.length > 0);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

export function bodyWithoutPrStack(body: string): string {
  // GitHub returns PR bodies with CRLF line endings, but we author them with
  // LF. Normalize first so the pattern matches on round-trips; otherwise the
  // old section is left in place and a duplicate gets appended.
  const stripped = body
    .replace(/\r\n/g, "\n")
    .replace(PR_STACK_SECTION_PATTERN, "")
    .trimEnd();

  return stripped.length > 0 ? `${stripped}\n\n` : "";
}

export function bookmarkHead(bookmark: string): string {
  const remoteIndex = bookmark.lastIndexOf("@");
  return remoteIndex === -1 ? bookmark : bookmark.slice(0, remoteIndex);
}

export async function bookmarkHeadsForChange(
  change: string,
): Promise<string[]> {
  const bookmarks = lines(
    (await exec(jjLogBookmarksCommand(jjconf, change))).stdout,
  );

  return unique(bookmarks.map(bookmarkHead));
}

async function localBookmarkHeadsForChange(change: string): Promise<string[]> {
  return unique(
    lines(
      await exec(
        `jj --config-file ${jjconf} log -r ${shellQuote(change)} --no-graph -T 'local_bookmarks.map(|b| b.name()).join("\\n") ++ "\\n"'`,
      ).then(mapToStdout),
    ),
  );
}

const prsByHead = new Map<string, PullRequest>();
const prsByNumber = new Map<number, PullRequest>();

function cachePr(pr: PullRequest, head?: string): PullRequest {
  if (head) {
    prsByHead.set(head, pr);
  }
  prsByNumber.set(pr.number, pr);
  return pr;
}

async function prForHead(head: string): Promise<PullRequest | undefined> {
  if (prsByHead.has(head)) {
    return prsByHead.get(head);
  }

  const existingPrs = await execToSchema(
    PullRequestListSchema,
    `gh pr list --head ${head} --json number,title,baseRefName,body`,
  );

  if (existingPrs[0]) {
    cachePr(existingPrs[0], head);
  }

  return existingPrs[0];
}

async function prForNumber(number: number): Promise<PullRequest> {
  const cached = prsByNumber.get(number);
  if (cached) {
    return cached;
  }

  return cachePr(
    await execToSchema(
      PullRequestSchema,
      `gh pr view ${String(number)} --json number,title,baseRefName,body`,
    ),
  );
}

async function preferredBookmarkHead(change: string): Promise<{
  head?: string;
  existingPr?: PullRequest;
}> {
  const bookmarkHeads = await bookmarkHeadsForChange(change);

  for (const head of bookmarkHeads) {
    const existingPr = await prForHead(head);
    if (existingPr) {
      return { head, existingPr };
    }
  }

  // Without a PR, a bookmark is only a usable head if it is local, since
  // that is what jj-pr can push -- its name doesn't matter (the configured
  // prefix only names bookmarks jj-pr invents). A remote-only bookmark
  // without a PR (deleted locally, or someone else's ref parked on the
  // commit) is treated as no bookmark at all, so the change gets a fresh
  // one, identically on every run.
  const localHeads = await localBookmarkHeadsForChange(change);
  return { head: bookmarkHeads.find((head) => localHeads.includes(head)) };
}

function sanitizeBookmarkDescription(
  description: string,
  fallback: string,
): string {
  // Only the summary line belongs in a bookmark name; stripping the newlines
  // out of a multi-line description would glue the body onto it.
  const slug = (description.split(/\r?\n/)[0] || fallback)
    .replace(/ /g, "-")
    .replace(/[^a-zA-Z0-9_-]/g, "")
    .replace(/--+/g, "-")
    .slice(0, 50)
    .replace(/-+$/g, "");

  return slug || fallback;
}

async function handlePush(spinner: Ora, revset: string, dryRun: boolean) {
  spinner.start();
  spinner.text = "planning push...";

  const dryRunOutput = await exec(
    `jj --config-file ${jjconf} git push --dry-run -r '${revset}'`,
  )
    .then(combineStdoutAndStderr)
    .then((str) => str.trim());

  if (dryRunOutput.trim().endsWith("Nothing changed.")) {
    return;
  }
  spinner.stop();

  if (dryRun) {
    console.log(dryRunOutput);
    return;
  }
  console.log(dryRunOutput.replace("\nDry-run requested, not pushing.", ""));

  const confirmed = await confirm("\npush these bookmarks? (⏎ / n)");

  if (!confirmed) {
    console.log("Aborted.");
    process.exit(1);
  }

  spinner.text = "pushing...";
  spinner.start();
  await exec(`jj --config-file ${jjconf} git push -r '${revset}'`);
}

async function ensureTrunk(): Promise<string> {
  const trunk = await exec(
    `jj --config-file ${jjconf} bookmark list -r 'trunk()' -T 'name ++ "\n"'`,
  )
    .then(mapToStdout)
    .then((x) => x.trim())
    .then(lines);
  if (!trunk[0]) {
    throw new Error("Unable to find trunk bookmark");
  }

  if (trunk.includes("main")) {
    return "main";
  }
  if (trunk.includes("master")) {
    return "master";
  }
  return trunk[0];
}

async function handleFix(spinner: Ora, revset: string, dryRun: boolean) {
  if (dryRun) return;

  spinner.start();
  spinner.text = "";

  const hasFixTools = await succeeds(
    `jj --config-file ${jjconf} config get fix.tools`,
  );

  if (hasFixTools) {
    spinner.text = "fixing...";
    await exec(`jj --config-file ${jjconf} fix -s '(${revset}) & mutable()'`);
  }
}

async function getBookmarksAndPRsForChanges(
  changes: string[],
): Promise<BookmarkResult[]> {
  return Promise.all(
    changes.map(async (change) => {
      const result = await preferredBookmarkHead(change);
      if (!result.head) {
        return { headBookmark: undefined, existingPr: undefined, change };
      }

      const headBookmark = result.head;
      const existingPr = result.existingPr;

      return { headBookmark, existingPr, change };
    }),
  );
}

async function takenBookmarkNames(): Promise<Set<string>> {
  return new Set(
    lines(
      await exec(
        `jj --config-file ${jjconf} bookmark list --all-remotes -T 'name ++ "\\n"'`,
      ).then(mapToStdout),
    ),
  );
}

function uniqueBookmarkName(base: string, taken: Set<string>): string {
  let name = base;
  for (let suffix = 2; taken.has(name); suffix++) {
    name = `${base}-${suffix}`;
  }
  taken.add(name);
  return name;
}

async function prepareNewBookmarks(
  bookmarksAndPRs: BookmarkResult[],
): Promise<BookmarkResultWithHead[]> {
  const bookmarkPrefix = await getBookmarkPrefix();
  const taken = await takenBookmarkNames();
  const withDescriptions = await Promise.all(
    bookmarksAndPRs
      .filter((change) => !change.headBookmark)
      .map(async (item) => ({
        item,
        changeitem: await execToSchema(
          JJLogItemJsonSchema,
          `jj --config-file ${jjconf} log -r ${shellQuote(item.change)} --no-graph -T 'json(self)'`,
        ),
      })),
  );

  // Names are reserved sequentially in stack order: a slug that collides
  // with an existing bookmark (local or remote) or with an earlier planned
  // one gets a -2/-3/... suffix, rather than failing `git push --named`
  // halfway through the stack.
  return withDescriptions.map(({ item: { change, ...item }, changeitem }) => ({
    change,
    ...item,
    headBookmark: uniqueBookmarkName(
      `${bookmarkPrefix}${sanitizeBookmarkDescription(changeitem.description, changeitem.change_id)}`,
      taken,
    ),
    new: true as const,
  }));
}

async function approveAndPushNewBookmarks(
  spinner: Ora,
  dryRun: boolean,
  bookmarksAndPRs: BookmarkResult[],
  approvedNewBookmarks: Set<string>,
): Promise<BookmarkResultWithHead[]> {
  const changesNeedingBookmarks = await prepareNewBookmarks(bookmarksAndPRs);
  const newBookmarks = changesNeedingBookmarks.map((b) => b.headBookmark);
  if (newBookmarks.length === 0) return existingBookmarkResults(bookmarksAndPRs);
  spinner.stop();
  console.log(`New bookmarks:\n${newBookmarks.join("\n")}`);

  if (dryRun) {
    // Don't push, but keep the planned bookmarks so the rest of the dry run
    // can report the PRs they would produce.
    return mergeBookmarkResults(bookmarksAndPRs, changesNeedingBookmarks);
  }
  const shouldPush = await confirm("push new bookmarks? (⏎ / n)");
  if (!shouldPush) {
    process.exit(0);
  }
  spinner.start();
  await Promise.all(
    changesNeedingBookmarks.map(async ({ headBookmark, change }) => {
      spinner.text = `pushing ${headBookmark}...`;
      approvedNewBookmarks.add(headBookmark);
      await exec(
        `jj --config-file ${jjconf} git push --named ${headBookmark}=${change}`,
      );
    }),
  );

  return mergeBookmarkResults(bookmarksAndPRs, changesNeedingBookmarks);
}

async function preferredProposedBookmarkHead(
  change: string,
  bookmarksAndPRs: BookmarkResultWithHead[],
): Promise<{
  head?: string;
  existingPr?: PullRequest;
}> {
  const plannedHeadsByChange = new Map(
    bookmarksAndPRs
      .filter((item) => item.new)
      .map((item) => [item.change, item.headBookmark]),
  );
  const closestBookmarkChanges = lines(
    await exec(
      `jj --config-file ${jjconf} log --no-graph -r ${shellQuote(
        `heads(trunk()..${change}- & ${proposedBookmarkRevset(bookmarksAndPRs)})`,
      )} -T 'change_id ++ "\n"'`,
    ).then(mapToStdout),
  );

  const bookmarkHeads = unique(
    (
      await Promise.all(
        closestBookmarkChanges.map(async (candidateChange) => [
          ...(plannedHeadsByChange.get(candidateChange)
            ? [plannedHeadsByChange.get(candidateChange)!]
            : []),
          ...(await bookmarkHeadsForChange(candidateChange)),
        ]),
      )
    ).flat(),
  );

  for (const head of bookmarkHeads) {
    const existingPr = await prForHead(head);
    if (existingPr) {
      return { head, existingPr };
    }
  }

  return { head: bookmarkHeads[0] };
}
interface PRPlanCreate {
  action: "create";
  headBookmark: string;
  baseBranch: string;
  existingPr?: undefined;
  change: string;
}
interface PRPlanUpdate {
  // base needs to move to a new branch
  action: "update";
  headBookmark: string;
  baseBranch: string;
  existingPr: PullRequest;
  change: string;
}
interface PRPlanNoop {
  // the base is already up-to-date
  action: "noop";
  headBookmark: string;
  baseBranch: string;
  existingPr: PullRequest;
  change: string;
}
type PRPlan = PRPlanCreate | PRPlanUpdate | PRPlanNoop;

async function createPrPlans(
  bookmarksAndPRs: BookmarkResultWithHead[],
  trunk: string,
): Promise<PRPlan[]> {
  const plans = await Promise.all(
    bookmarksAndPRs.map(
      async ({ headBookmark, existingPr, change }): Promise<PRPlan> => {
        const baseBranch =
          (await preferredProposedBookmarkHead(change, bookmarksAndPRs)).head ??
          trunk;

        if (!existingPr) {
          return { action: "create", headBookmark, baseBranch, change };
        }
        if (existingPr.baseRefName === baseBranch) {
          return {
            action: "noop",
            headBookmark,
            baseBranch,
            existingPr,
            change,
          };
        }
        return {
          action: "update",
          headBookmark,
          baseBranch,
          existingPr,
          change,
        };
      },
    ),
  );
  return plans;
}

function plansToString(plans: PRPlan[]): string {
  type GroupedPlans = {
    create: PRPlanCreate[];
    update: PRPlanUpdate[];
    noop: PRPlanNoop[];
  };
  const groupedPlans: GroupedPlans = { create: [], update: [], noop: [] };
  plans.forEach((plan) => {
    switch (plan.action) {
      case "create":
        groupedPlans.create.push(plan);
        break;
      case "update":
        groupedPlans.update.push(plan);
        break;
      case "noop":
        groupedPlans.noop.push(plan);
        break;
    }
  });
  let result = "";

  if (!groupedPlans.create.length && !groupedPlans.update.length)
    return `all PRs already up-to-date.`;

  if (groupedPlans.create.length) {
    result += `create these PRs:\n`;
    result += groupedPlans.create
      .map((plan) => `${plan.headBookmark} -> ${plan.baseBranch}`)
      .join("\n");
    result += "\n";
  }

  if (groupedPlans.update.length) {
    result += `update these PR base branches:\n`;
    result += groupedPlans.update
      .map(
        (plan) =>
          `${plan.existingPr.number} ${plan.baseBranch} (from ${plan.existingPr?.baseRefName})`,
      )
      .join("\n");
    result += "\n";
  }

  if (groupedPlans.noop.length) {
    result += `PRs already up-to-date:\n`;
    result += groupedPlans.noop
      .map((plan) => `${plan.headBookmark} (base: ${plan.baseBranch})`)
      .join("\n");
    result += "\n";
  }
  return result;
}

type PlannedStackEntry =
  | {
      kind: "existing";
      change: string;
      headBookmark: string;
      pr: PullRequest;
    }
  | {
      kind: "new";
      change: string;
      headBookmark: string;
    };

function plannedStackEntries(plans: PRPlan[]): PlannedStackEntry[] {
  return plans.map((plan) => {
    if (plan.action === "create") {
      return {
        kind: "new",
        change: plan.change,
        headBookmark: plan.headBookmark,
      };
    }

    return {
      kind: "existing",
      change: plan.change,
      headBookmark: plan.headBookmark,
      pr: plan.existingPr,
    };
  });
}

// Dry-run stand-in for the map alignPRs builds on a real run: the PRs that
// already exist, keyed by change. Planned PRs have no number yet, so they are
// absent here and only appear in the planned stack markdown.
function plannedPrInfo(
  plans: PRPlan[],
): Map<string, { number: number; body: string }> {
  return new Map(
    plannedStackEntries(plans)
      .filter(
        (entry): entry is Extract<PlannedStackEntry, { kind: "existing" }> =>
          entry.kind === "existing",
      )
      .map((entry) => [
        entry.change,
        { number: entry.pr.number, body: entry.pr.body ?? "" },
      ]),
  );
}

function plannedStackMarkdown(
  plans: PRPlan[],
  changes: string[],
  trunk: string,
  nameWithOwner: string,
): string {
  const entriesByChange = new Map(
    plannedStackEntries(plans).map((entry) => [entry.change, entry]),
  );
  const stackLines = ["## PR Stack"];
  for (const change of [...changes].reverse()) {
    const entry = entriesByChange.get(change);
    if (entry === undefined) {
      continue;
    }

    if (entry.kind === "existing") {
      stackLines.push(
        `- https://github.com/${nameWithOwner}/pull/${entry.pr.number}`,
      );
      continue;
    }

    stackLines.push(`- [new PR] ${entry.headBookmark}`);
  }
  stackLines.push(`- \`${trunk}\``);

  return `${stackLines.join("\n")}\n`;
}

// `gh pr create --fill` derives the title/body from local git commits, which
// don't exist in a non-colocated workspace (jj only auto-exports bookmarks to
// git refs in colocated checkouts). Build them from the jj description instead.
async function prTitleAndBody(
  change: string,
  fallbackTitle: string,
): Promise<{ title: string; body: string }> {
  const item = await execToSchema(
    JJLogItemJsonSchema,
    `jj --config-file ${jjconf} log -r ${shellQuote(change)} --no-graph -T 'json(self)'`,
  );
  const [summary = "", ...rest] = item.description.split(/\r?\n/);
  return {
    title: summary.trim() || fallbackTitle,
    body: rest.join("\n").trim(),
  };
}

async function alignPRs(spinner: Ora, plans: PRPlan[], dryRun: boolean) {
  const prsByChange = new Map<string, { number: number; body: string }>();

  for (const plan of plans) {
    if (plan.action === "noop") {
      prsByChange.set(plan.change, {
        number: plan.existingPr.number,
        body: plan.existingPr.body ?? "",
      });
      continue;
    }

    if (dryRun) continue;

    const { action, headBookmark, baseBranch, existingPr, change } = plan;

    if (action === "update") {
      spinner.text = `updating base branch for ${headBookmark}...`;
      await exec(`gh pr edit ${existingPr.number} --base ${baseBranch}`);

      prsByChange.set(change, {
        number: existingPr.number,
        body: existingPr.body ?? "",
      });

      continue;
    }

    if (action === "create") {
      spinner.text = `creating new PR for ${headBookmark}...`;
      const { title, body } = await prTitleAndBody(change, headBookmark);
      await execWithStdin(
        `gh pr create --head ${headBookmark} --base ${baseBranch} --draft --title ${shellQuote(title)} --body-file -`,
        body,
      );

      const createdPrs = await execToSchema(
        PullRequestListSchema,
        `gh pr list --head ${headBookmark} --json number,title,baseRefName,body`,
      );
      if (!createdPrs[0]) {
        throw new Error(`Unable to find PR created for ${headBookmark}`);
      }

      const createdPr = cachePr(createdPrs[0], headBookmark);
      prsByChange.set(change, {
        number: createdPr.number,
        body: createdPr.body ?? "",
      });
    }
  }
  return prsByChange;
}

async function doFetch(spinner: Ora) {
  spinner.start();
  spinner.text = "fetching...";
  await exec(`jj git fetch`);
  spinner.stop();
}

async function doRebase(spinner: Ora, dryRun: boolean, gitDir: string) {
  spinner.start();
  spinner.text = "planning rebase...";

  const state = await loadRebaseState(gitDir);
  const { abandoned, stalePointer } = await findAbandonedBookmarksSince(
    state?.lastCheckedOp ?? null,
  );

  if (stalePointer) {
    spinner.stop();
    console.log(
      "Rebase checkpoint not found in current op history; resetting checkpoint.",
    );
    spinner.start();
  }

  if (abandoned.length === 0) {
    if (!dryRun) {
      await saveRebaseCheckpoint(gitDir);
    }
    return;
  }

  const plans: RebasePlan[] = await planRebasesFromAbandoned(abandoned);

  if (plans.length === 0) {
    if (!dryRun) {
      await saveRebaseCheckpoint(gitDir);
    }
    return;
  }
  spinner.stop();
  for (const plan of plans) {
    console.log(
      `${plan.bookmark.name}: ${plan.bookmark.previousCommit} -> absent`,
    );
    console.log(`roots above it: ${plan.roots.join(", ")}`);

    const cmd = `jj rebase ${[...plan.roots.flatMap((root) => ["-s", root])].join(" ")} -d 'trunk()'`;
    if (dryRun) {
      console.log(`$ ${cmd}`);
    } else {
      await exec(cmd);
    }
  }

  if (!dryRun) {
    await saveRebaseCheckpoint(gitDir);
  }
}

// Expands the user-supplied -r value into a revset covering every revision it
// resolves to. constructRevset collapses a compound revset like "a|b" to its
// heads, which silently drops explicitly selected revisions; resolving to
// concrete change ids first and expanding each one preserves them all.
async function constructRevsetForRevision(revision: string): Promise<string> {
  const revisions = await exec(
    `jj --config-file ${jjconf} log --no-graph --reversed -r ${shellQuote(revision)} -T 'change_id ++ "\n"'`,
  )
    .then(mapToStdout)
    .then(lines);

  if (revisions.length === 0) {
    return "";
  }

  return revisions.map(constructRevset).join(" | ");
}

export async function main(spinner: Ora, args: CliArgs) {
  const trunk = await ensureTrunk();
  const gitDir = await absoluteGitDir();

  await doFetch(spinner);

  if (args.rebase) {
    await doRebase(spinner, args.dryRun, gitDir);
  }

  const revset = await constructRevsetForRevision(args.revision);
  if (!revset) {
    spinner.text = "nothing to do.";
    spinner.stopAndPersist();
    process.exit(0);
  }

  await handleFix(spinner, revset, args.dryRun);

  await handlePush(spinner, revset, args.dryRun);

  spinner.start();
  spinner.text = "gathering changes...";
  const changes = await exec(
    `jj --config-file ${jjconf} log --no-graph --reversed -r '(${revset}) & mutable()' -T 'change_id ++ "\n"'`,
  )
    .then(mapToStdout)
    .then(lines);

  if (!changes.length) {
    spinner.text = "nothing to do.";
    spinner.stopAndPersist();
    process.exit(0);
  }

  const approvedNewBookmarks = new Set<string>();

  const changesBeforePushNewBookmarks =
    await getBookmarksAndPRsForChanges(changes);

  const bookmarksAndPRs = await approveAndPushNewBookmarks(
    spinner,
    args.dryRun,
    changesBeforePushNewBookmarks,
    approvedNewBookmarks,
  );

  spinner.text = "planning pr changes...";
  const plans = await createPrPlans(bookmarksAndPRs, trunk);

  // this should never happen.
  if (plans.length === 0) {
    throw new Error("no plans to execute");
  }

  spinner.stop();
  console.log(plansToString(plans));

  spinner.stop();

  const prChangesAlreadyApproved = plans.every((plan) => {
    if (plan.action === "noop") return true;
    if (plan.action === "create") {
      return approvedNewBookmarks.has(plan.headBookmark);
    }
    return false;
  });
  const shouldProceed =
    args.dryRun ||
    prChangesAlreadyApproved ||
    (await confirm("update PRs? (⏎ / n)"));

  if (!shouldProceed) {
    spinner.stopAndPersist();
    process.exit(0);
  }

  const prInfo = await alignPRs(spinner, plans, args.dryRun);

  const repo = await execToSchema(
    RepoSchema,
    `gh repo view --json nameWithOwner`,
  );

  const stackMarkdown = args.dryRun
    ? plannedStackMarkdown(plans, changes, trunk, repo.nameWithOwner)
    : (() => {
        const stackLines = ["## PR Stack"];
        for (const change of [...changes].reverse()) {
          const number = prInfo.get(change)?.number;
          if (number !== undefined) {
            stackLines.push(
              `- https://github.com/${repo.nameWithOwner}/pull/${number}`,
            );
          }
        }
        stackLines.push(`- \`${trunk}\``);
        return `${stackLines.join("\n")}\n`;
      })();
  const descriptionPrInfo = args.dryRun ? plannedPrInfo(plans) : prInfo;
  spinner.stop();

  spinner.text = "updating descriptions...";
  spinner.start();

  await Promise.allSettled(
    changes.map(async (change) => {
      const number = descriptionPrInfo.get(change)?.number;
      if (number === undefined) {
        return;
      }

      const current = await prForNumber(number);
      const currentBody = current.body ?? "";
      const bodyWithoutOldStack = bodyWithoutPrStack(currentBody);
      const newBody = `${bodyWithoutOldStack}${stackMarkdown}`;

      if (newBody === currentBody) return;
      if (args.dryRun) {
        spinner.stop();
        console.log(`would update description for PR #${number}`);
        return;
      }
      spinner.text = `updating description for PR #${number}...`;
      await execWithStdin(`gh pr edit ${number} --body-file -`, newBody);
      current.body = newBody;
      cachePr(current);
    }),
  );
  spinner.stop();
  console.log(stackMarkdown);
}

if (import.meta.main) {
  const rawArgs = process.argv.slice(2);
  if (rawArgs[0] === "completion") {
    const shell = rawArgs[1];
    if (!shell || !isShell(shell)) {
      console.error(`Usage: jj-pr completion <${SHELLS.join("|")}>`);
      process.exit(1);
    }
    console.log(completionScript(shell));
    process.exit(0);
  }

  const spinner = ora("").start();
  try {
    const args = parseCli(rawArgs);

    if (args.help) {
      spinner.stop();
      console.log(help());
      process.exit(0);
    }

    if (args.dryRun) {
      spinner.stop();
      console.log("dry run starting...");
      spinner.start();
    }

    await main(spinner, args);
  } finally {
    spinner.stop();
  }
}
