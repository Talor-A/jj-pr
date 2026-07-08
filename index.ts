#!/usr/bin/env node
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { constructRevset } from "./lib/revset";
import ora, { type Ora } from "ora";
import {
  combineStdoutAndStderr,
  exec,
  execToSchema,
  execWithStdin,
  mapToStdout,
  shellQuote,
} from "./lib/exec";
import { help, parseCli, type CliArgs } from "./lib/args";
import { completionScript, isShell, SHELLS } from "./lib/completion";
import {
  detectMergedAncestors,
  type MergedAncestorDetection,
  type MergedAncestorPr,
} from "./lib/merged-prs";
import {
  jjLogBookmarksCommand,
  mergeBookmarkResults,
  parsePrStackSection,
  proposedBookmarkRevset,
  PR_STACK_SECTION_PATTERN,
  renderStackMarkdown,
  type BookmarkResult,
  type BookmarkResultWithHead,
  type StackEntry,
} from "./lib/pr-stack";
import {
  JJLogItemJsonSchema,
  PrStateSchema,
  PullRequestListSchema,
  PullRequestSchema,
  RepoSchema,
  type PullRequest,
} from "./lib/schema";
import pkg from "./package.json";

import { jj, jjCommand, jjStdoutLines, configGet, hasConfig, changeIdsIn } from "./lib/jj";
import { lines, unique } from "./lib/utils";

let _bookmarkPrefix: string | undefined;
// Resolved bookmark prefix for newly-created bookmarks. Prefers the
// `jj-pr.bookmark-prefix` config key (layered from the user's jj config),
// falling back to `<user>/jj/` derived from `user.email`.
async function getBookmarkPrefix(): Promise<string> {
  if (_bookmarkPrefix !== undefined) return _bookmarkPrefix;

  const configured = (await configGet("jj-pr.bookmark-prefix")) ?? "";

  let prefix = configured;
  if (!prefix) {
    const email = (await configGet("user.email")) ?? "";
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

  const hasFixTools = await hasConfig("fix.tools");

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
          jjCommand(
            `log -r ${shellQuote(item.change)} --no-graph -T 'json(self)'`,
          ),
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

async function preferredProposedBookmarkHead(
  change: string,
  bookmarksAndPRs: BookmarkResultWithHead[],
  // Revset fragment excluding merged-PR heads (and their ancestry) from base
  // candidacy: pre-rebase they still sit between trunk and the change, but
  // the plan must match the post-rebase graph, where they are gone.
  excludeMerged: string = "",
): Promise<{
  head?: string;
  existingPr?: PullRequest;
}> {
  const plannedHeadsByChange = new Map(
    bookmarksAndPRs
      .filter((item) => item.new)
      .map((item) => [item.change, item.headBookmark]),
  );
  const closestBookmarkChanges = await changeIdsIn(
    `heads(trunk()..${change}- & ${proposedBookmarkRevset(bookmarksAndPRs)}${excludeMerged})`,
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
  excludeMerged: string = "",
): Promise<PRPlan[]> {
  const plans = await Promise.all(
    bookmarksAndPRs.map(
      async ({ headBookmark, existingPr, change }): Promise<PRPlan> => {
        const baseBranch =
          (
            await preferredProposedBookmarkHead(
              change,
              bookmarksAndPRs,
              excludeMerged,
            )
          ).head ?? trunk;

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
async function prTitleAndBody(
  change: string,
  fallbackTitle: string,
): Promise<{ title: string; body: string }> {
  const item = await execToSchema(
    JJLogItemJsonSchema,
    jjCommand(`log -r ${shellQuote(change)} --no-graph -T 'json(self)'`),
  );
  const [summary = "", ...rest] = item.description.split(/\r?\n/);
  return {
    title: summary.trim() || fallbackTitle,
    body: rest.join("\n").trim(),
  };
}

async function alignPRs(spinner: Ora, plans: PRPlan[]) {
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

// Assembles the merged-PR tail for the stack section: PRs detected as merged
// this run, then entries displaced from the live stack and confirmed merged
// via one `gh pr view` each (covers a stack the user already rebased by
// hand), then entries already carried below the trunk line, which need no
// lookup -- once below the line, always carried.
async function mergedTailFor(
  detection: MergedAncestorDetection,
  liveStackNumbers: Set<number>,
  bodies: string[],
): Promise<number[]> {
  const parsed = bodies.flatMap((body) => parsePrStackSection(body) ?? []);
  const carried = parsed.flatMap((section) => section.below);
  const detected = detection.merged.map((m) => m.prNumber);
  const displaced = unique(parsed.flatMap((section) => section.above)).filter(
    (number) =>
      !liveStackNumbers.has(number) &&
      !detected.includes(number) &&
      !carried.includes(number),
  );

  const displacedMerged: number[] = [];
  for (const number of displaced) {
    const state = await execToSchema(
      PrStateSchema,
      `gh pr view ${String(number)} --json number,state`,
    ).catch(() => undefined);
    if (state?.state === "MERGED") displacedMerged.push(number);
  }

  return unique([...detected, ...displacedMerged, ...carried]);
}

function rebaseCommandFor(source: MergedAncestorPr): string {
  return `jj rebase -s '${source.headRefOid}+ & mutable()' -d 'trunk()'`;
}

// Everything a run would do, gathered read-only so it can be rendered and
// confirmed as a whole before anything mutates.
interface ExecutionPlan {
  revset: string;
  pushPreview: string | null; // from planPush
  rebases: MergedAncestorPr[]; // stranded stacks to rebase onto trunk first
  mergedTail: number[]; // merged ancestor PRs kept below the trunk line
  newBookmarks: BookmarkResultWithHead[]; // named but NOT yet pushed (new: true)
  prPlans: PRPlan[];
  changes: string[]; // oldest-first change ids
  trunk: string;
  nameWithOwner: string;
}

async function executePlan(spinner: Ora, plan: ExecutionPlan): Promise<void> {
  spinner.start();

  for (const source of plan.rebases) {
    spinner.text = `rebasing changes stranded above merged PR #${source.prNumber}...`;
    await jj(
      `rebase -s ${shellQuote(`${source.headRefOid}+ & mutable()`)} -d 'trunk()'`,
    );
  }
  if (plan.rebases.length > 0) {
    const conflicted = await jjStdoutLines(
      `log --no-graph -r ${shellQuote(`(${plan.revset}) & conflicts()`)} -T 'change_id.short() ++ "\n"'`,
    );
    if (conflicted.length > 0) {
      spinner.stop();
      console.error(
        `rebase produced conflicts in: ${conflicted.join(", ")}\n` +
          "resolve them and re-run jj pr; nothing was pushed.",
      );
      process.exit(1);
    }
  }

  // A rebase moves bookmarks sideways even when the pre-rebase preview saw
  // nothing to push, so the push cannot be skipped on preview alone. The
  // revset re-resolves here, after the rebase, so it pushes the new commits.
  if (plan.pushPreview !== null || plan.rebases.length > 0) {
    spinner.text = "pushing...";
    const pushOutput = await jj(`git push -r '${plan.revset}'`).then(
      combineStdoutAndStderr,
    );
    // After a rebase the bookmarks always moved, so a "Nothing changed."
    // push means jj refused to push them (e.g. "Won't push bookmark ...:
    // commit has no author and/or committer set") -- jj reports that as a
    // warning with exit 0, so surface it or the run silently claims success.
    if (
      plan.rebases.length > 0 &&
      pushOutput.trim().endsWith("Nothing changed.")
    ) {
      spinner.stop();
      console.error(
        `rebase succeeded but the push moved nothing:\n${pushOutput.trim()}\n` +
          "the remote still has the pre-rebase commits; nothing else was updated.",
      );
      process.exit(1);
    }
  }

  await Promise.all(
    plan.newBookmarks.map(async ({ headBookmark, change }) => {
      spinner.text = `pushing ${headBookmark}...`;
      await jj(`git push --named ${headBookmark}=${change}`);
    }),
  );

  const prInfo = await alignPRs(spinner, plan.prPlans);

  const stackMarkdown = renderStackMarkdown(
    stackEntriesForPlans(plan.prPlans, plan.changes).map((entry) => ({
      ...entry,
      prNumber: prInfo.get(entry.change)?.number,
    })),
    plan.trunk,
    plan.nameWithOwner,
    plan.mergedTail,
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

// Expands the user-supplied -r value into a revset covering every revision it
// resolves to. constructRevset collapses a compound revset like "a|b" to its
// heads, which silently drops explicitly selected revisions; resolving to
// concrete change ids first and expanding each one preserves them all.
async function constructRevsetForRevision(revision: string): Promise<string> {
  const revisions = await changeIdsIn(revision, { reversed: true });

  if (revisions.length === 0) {
    return "";
  }

  return revisions.map(constructRevset).join(" | ");
}

export async function main(spinner: Ora, args: CliArgs) {
  const trunk = await ensureTrunk();

  await doFetch(spinner);

  const userRevset = await constructRevsetForRevision(args.revision);
  if (!userRevset) {
    spinner.text = "nothing to do.";
    spinner.stopAndPersist();
    process.exit(0);
  }

  const repo = await execToSchema(
    RepoSchema,
    `gh repo view --json nameWithOwner`,
  );

  // Read-only: probes the stack's base commits against GitHub to find PRs
  // that merged underneath it (see lib/merged-prs.ts).
  spinner.start();
  spinner.text = "checking for merged ancestor PRs...";
  const detection = await detectMergedAncestors(
    userRevset,
    repo.nameWithOwner,
  );

  // Plan everything as if the rebase already ran: merged heads and their
  // ancestry drop out of the working revset (their content landed in trunk),
  // so bookmark and base planning match the post-rebase graph. The actual
  // `jj rebase` only runs in executePlan, after the confirm prompt.
  const excludeMerged =
    detection.rebaseSources.length > 0
      ? ` & ~::(${detection.rebaseSources.map((m) => m.headRefOid).join(" | ")})`
      : "";
  const revset =
    excludeMerged === "" ? userRevset : `(${userRevset})${excludeMerged}`;

  await handleFix(spinner, revset, args.dryRun);

  // Gather: read-only. Nothing below may touch the repo, the remote, or
  // GitHub until the whole plan has been rendered and confirmed.
  spinner.start();
  spinner.text = "planning push...";
  const pushPreview = await planPush(revset);

  spinner.text = "gathering changes...";
  const changes = await changeIdsIn(`(${revset}) & mutable()`, {
    reversed: true,
  });

  if (!changes.length) {
    spinner.text = "nothing to do.";
    spinner.stopAndPersist();
    process.exit(0);
  }

  const bookmarkResults = await getBookmarksAndPRsForChanges(changes);
  const newBookmarks = await prepareNewBookmarks(bookmarkResults);
  const bookmarksAndPRs = mergeBookmarkResults(bookmarkResults, newBookmarks);

  spinner.text = "planning pr changes...";
  const prPlans = await createPrPlans(bookmarksAndPRs, trunk, excludeMerged);

  // this should never happen.
  if (prPlans.length === 0) {
    throw new Error("no plans to execute");
  }

  const existingPrBodies = prPlans.flatMap((prPlan) =>
    prPlan.existingPr?.body ? [prPlan.existingPr.body] : [],
  );
  const mergedTail = await mergedTailFor(
    detection,
    new Set(
      prPlans.flatMap((prPlan) =>
        prPlan.existingPr ? [prPlan.existingPr.number] : [],
      ),
    ),
    existingPrBodies,
  );

  const plan: ExecutionPlan = {
    revset,
    pushPreview,
    rebases: detection.rebaseSources,
    mergedTail,
    newBookmarks,
    prPlans,
    changes,
    trunk,
    nameWithOwner: repo.nameWithOwner,
  };

  // Render: one summary of everything the run would do.
  spinner.stop();
  if (plan.rebases.length > 0) {
    console.log("Merged PRs left the stack; stranded changes will be rebased:");
    for (const source of plan.rebases) {
      console.log(
        `  PR #${source.prNumber} (${source.headRefName}) merged: $ ${rebaseCommandFor(source)}`,
      );
    }
  }
  if (plan.pushPreview !== null) {
    console.log(plan.pushPreview);
    if (plan.rebases.length > 0) {
      console.log(
        "note: commit ids above are pre-rebase; the push targets the rebased commits",
      );
    }
  } else if (plan.rebases.length > 0) {
    console.log("bookmarks on rebased changes will be pushed after the rebase");
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
      plan.mergedTail,
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

  // Confirm: one prompt covering the rebases, pushes, PR creations, and
  // retargets. Description upkeep alone (everything already up-to-date)
  // needs none.
  const onlyDescriptionUpkeep =
    plan.pushPreview === null &&
    plan.rebases.length === 0 &&
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
