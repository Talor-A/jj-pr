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
  jjLogBookmarksCommand,
  mergeBookmarkResults,
  proposedBookmarkRevset,
  renderStackMarkdown,
  type BookmarkResult,
  type BookmarkResultWithHead,
  type StackEntry,
} from "./lib/pr-stack";
import {
  JJLogItemJsonSchema,
  PullRequestListSchema,
  PullRequestSchema,
  RepoSchema,
  type PullRequest,
} from "./lib/schema";
import pkg from "./package.json";

import { jj, jjCommand, jjStdoutLines } from "./lib/jj";
import { lines, parseJsonLines, unique } from "./lib/utils";

type JJLogItem = z.infer<typeof JJLogItemJsonSchema>;

function requireChangeMetadata(
  metadataByChange: Map<string, JJLogItem>,
  change: string,
): JJLogItem {
  const item = metadataByChange.get(change);
  if (item === undefined) {
    throw new Error(`Missing jj metadata for change ${change}`);
  }
  return item;
}

let _bookmarkPrefix: string | undefined;
// Resolved bookmark prefix for newly-created bookmarks. Prefers the
// `jj-pr.bookmark-prefix` config key (layered from the user's jj config),
// falling back to `<user>/jj/` derived from `user.email`.
async function getBookmarkPrefix(): Promise<string> {
  if (_bookmarkPrefix !== undefined) return _bookmarkPrefix;

  const configured = await jj(`config get jj-pr.bookmark-prefix`)
    .then(mapToStdout)
    .then((s) => s.trim())
    .catch(() => ""); // key unset -> jj exits non-zero

  let prefix = configured;
  if (!prefix) {
    const email = await jj(`config get user.email`)
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
  const bookmarks = lines((await exec(jjLogBookmarksCommand(change))).stdout);

  return unique(bookmarks.map(bookmarkHead));
}

async function localBookmarkHeadsForChange(change: string): Promise<string[]> {
  return unique(
    await jjStdoutLines(
      `log -r ${shellQuote(change)} --no-graph -T 'local_bookmarks.map(|b| b.name()).join("\\n") ++ "\\n"'`,
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

// Gather half: read-only. Returns the human-readable push preview, or null
// when jj reports nothing to push. Strips jj's dry-run disclaimer line.
async function planPush(revset: string): Promise<string | null> {
  const output = await jj(`git push --dry-run -r '${revset}'`)
    .then(combineStdoutAndStderr)
    .then((s) => s.trim());
  if (output.endsWith("Nothing changed.")) return null;
  return output.replace("\nDry-run requested, not pushing.", "");
}

async function ensureTrunk(): Promise<string> {
  const trunk = await jj(`bookmark list -r 'trunk()' -T 'name ++ "\n"'`)
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

  const hasFixTools = await succeeds(jjCommand(`config get fix.tools`));

  if (hasFixTools) {
    spinner.text = "fixing...";
    await jj(`fix -s '(${revset}) & mutable()'`);
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
    await jjStdoutLines(`bookmark list --all-remotes -T 'name ++ "\\n"'`),
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
  metadataByChange: Map<string, JJLogItem>,
): Promise<BookmarkResultWithHead[]> {
  const bookmarkPrefix = await getBookmarkPrefix();
  const taken = await takenBookmarkNames();
  const withDescriptions = bookmarksAndPRs
    .filter((change) => !change.headBookmark)
    .map((item) => ({
      item,
      changeitem: requireChangeMetadata(metadataByChange, item.change),
    }));

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
  const closestBookmarkChanges = await jjStdoutLines(
    `log --no-graph -r ${shellQuote(
      `heads(trunk()..${change}- & ${proposedBookmarkRevset(bookmarksAndPRs)})`,
    )} -T 'change_id ++ "\n"'`,
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

// Stack entries in `changes` order (oldest first). Plans for changes with an
// existing PR carry its number; planned-but-uncreated PRs have none.
function stackEntriesForPlans(
  plans: PRPlan[],
  changes: string[],
): StackEntry[] {
  const plansByChange = new Map(plans.map((plan) => [plan.change, plan]));
  return changes.flatMap((change) => {
    const plan = plansByChange.get(change);
    if (plan === undefined) {
      return [];
    }
    return [
      {
        change,
        headBookmark: plan.headBookmark,
        prNumber: plan.existingPr?.number,
      },
    ];
  });
}

// `gh pr create --fill` derives the title/body from local git commits, which
// don't exist in a non-colocated workspace (jj only auto-exports bookmarks to
// git refs in colocated checkouts). Build them from the jj description instead.
function prTitleAndBody(
  change: string,
  fallbackTitle: string,
  metadataByChange: Map<string, JJLogItem>,
): { title: string; body: string } {
  const item = requireChangeMetadata(metadataByChange, change);
  const [summary = "", ...rest] = item.description.split(/\r?\n/);
  return {
    title: summary.trim() || fallbackTitle,
    body: rest.join("\n").trim(),
  };
}

async function alignPRs(
  spinner: Ora,
  plans: PRPlan[],
  metadataByChange: Map<string, JJLogItem>,
) {
  const prsByChange = new Map<string, { number: number; body: string }>();

  for (const plan of plans) {
    if (plan.action === "noop") {
      prsByChange.set(plan.change, {
        number: plan.existingPr.number,
        body: plan.existingPr.body ?? "",
      });
      continue;
    }

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
      const { title, body } = prTitleAndBody(
        change,
        headBookmark,
        metadataByChange,
      );
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

// Everything a run would do, gathered read-only so it can be rendered and
// confirmed as a whole before anything mutates.
interface ExecutionPlan {
  revset: string;
  pushPreview: string | null; // from planPush
  newBookmarks: BookmarkResultWithHead[]; // named but NOT yet pushed (new: true)
  prPlans: PRPlan[];
  changes: string[]; // oldest-first change ids
  changeMetadata: Map<string, JJLogItem>; // keyed by change id, covers `changes`
  trunk: string;
  nameWithOwner: string;
}

async function executePlan(spinner: Ora, plan: ExecutionPlan): Promise<void> {
  spinner.start();

  if (plan.pushPreview !== null) {
    spinner.text = "pushing...";
    await jj(`git push -r '${plan.revset}'`);
  }

  await Promise.all(
    plan.newBookmarks.map(async ({ headBookmark, change }) => {
      spinner.text = `pushing ${headBookmark}...`;
      await jj(`git push --named ${headBookmark}=${change}`);
    }),
  );

  const prInfo = await alignPRs(spinner, plan.prPlans, plan.changeMetadata);

  const stackMarkdown = renderStackMarkdown(
    stackEntriesForPlans(plan.prPlans, plan.changes).map((entry) => ({
      ...entry,
      prNumber: prInfo.get(entry.change)?.number,
    })),
    plan.trunk,
    plan.nameWithOwner,
  );

  spinner.text = "updating descriptions...";

  const results = await Promise.allSettled(
    plan.changes.map(async (change) => {
      const number = prInfo.get(change)?.number;
      if (number === undefined) {
        return;
      }

      const current = await prForNumber(number);
      const currentBody = current.body ?? "";
      const newBody = `${bodyWithoutPrStack(currentBody)}${stackMarkdown}`;

      if (newBody === currentBody) return;
      spinner.text = `updating description for PR #${number}...`;
      await execWithStdin(`gh pr edit ${number} --body-file -`, newBody);
      current.body = newBody;
      cachePr(current);
    }),
  );

  spinner.stop();

  results.forEach((result, index) => {
    if (result.status !== "rejected") return;
    const change = plan.changes[index];
    const number =
      change === undefined ? undefined : prInfo.get(change)?.number;
    const message =
      result.reason instanceof Error
        ? result.reason.message
        : String(result.reason);
    console.error(`failed to update description for PR #${number}: ${message}`);
    process.exitCode = 1;
  });

  console.log(stackMarkdown);
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
  const revisions = await jjStdoutLines(
    `log --no-graph --reversed -r ${shellQuote(revision)} -T 'change_id ++ "\n"'`,
  );

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

  // Gather: read-only. Nothing below may touch the repo, the remote, or
  // GitHub until the whole plan has been rendered and confirmed.
  spinner.start();
  spinner.text = "planning push...";
  const pushPreview = await planPush(revset);

  spinner.text = "gathering changes...";
  const changeItems = parseJsonLines(
    JJLogItemJsonSchema,
    await jj(
      `log --no-graph --reversed -r '(${revset}) & mutable()' -T 'json(self) ++ "\n"'`,
    ).then(mapToStdout),
  );
  const changes = changeItems.map((item) => item.change_id);
  const changeMetadata = new Map(
    changeItems.map((item) => [item.change_id, item]),
  );

  if (!changes.length) {
    spinner.text = "nothing to do.";
    spinner.stopAndPersist();
    process.exit(0);
  }

  const bookmarkResults = await getBookmarksAndPRsForChanges(changes);
  const newBookmarks = await prepareNewBookmarks(
    bookmarkResults,
    changeMetadata,
  );
  const bookmarksAndPRs = mergeBookmarkResults(bookmarkResults, newBookmarks);

  spinner.text = "planning pr changes...";
  const prPlans = await createPrPlans(bookmarksAndPRs, trunk);

  // this should never happen.
  if (prPlans.length === 0) {
    throw new Error("no plans to execute");
  }

  const repo = await execToSchema(
    RepoSchema,
    `gh repo view --json nameWithOwner`,
  );

  const plan: ExecutionPlan = {
    revset,
    pushPreview,
    newBookmarks,
    prPlans,
    changes,
    changeMetadata,
    trunk,
    nameWithOwner: repo.nameWithOwner,
  };

  // Render: one summary of everything the run would do.
  spinner.stop();
  if (plan.pushPreview !== null) {
    console.log(plan.pushPreview);
  }
  if (plan.newBookmarks.length > 0) {
    console.log(
      `New bookmarks:\n${plan.newBookmarks.map((b) => b.headBookmark).join("\n")}`,
    );
  }
  console.log(plansToString(plan.prPlans));

  if (args.dryRun) {
    const stackMarkdown = renderStackMarkdown(
      stackEntriesForPlans(plan.prPlans, plan.changes),
      plan.trunk,
      plan.nameWithOwner,
    );
    console.log(stackMarkdown);
    for (const prPlan of plan.prPlans) {
      if (prPlan.existingPr === undefined) continue;
      const currentBody = prPlan.existingPr.body ?? "";
      const newBody = `${bodyWithoutPrStack(currentBody)}${stackMarkdown}`;
      if (newBody !== currentBody) {
        console.log(
          `would update description for PR #${prPlan.existingPr.number}`,
        );
      }
    }
    return;
  }

  // Confirm: one prompt covering the pushes, PR creations, and retargets.
  // Description upkeep alone (everything already up-to-date) needs none.
  const onlyDescriptionUpkeep =
    plan.pushPreview === null &&
    plan.newBookmarks.length === 0 &&
    plan.prPlans.every((prPlan) => prPlan.action === "noop");
  if (!onlyDescriptionUpkeep) {
    const confirmed = await confirm("apply these changes? (⏎ / n)");
    if (!confirmed) {
      console.log("Aborted.");
      process.exit(1);
    }
  }

  await executePlan(spinner, plan);
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

    if (args.version) {
      spinner.stop();
      console.log(pkg.version);
      process.exit(0);
    }

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
