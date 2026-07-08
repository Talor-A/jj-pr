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
  succeeds,
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
  parsePrStackSection,
  proposedBookmarkRevset,
  PR_STACK_SECTION_PATTERN,
  renderStackMarkdown,
  type PlannedBookmark,
  type PRPlan,
  type ResolvedBookmark,
  type StackEntry,
} from "./lib/pr-stack";
import { parsePushPreview, type PushMove } from "./lib/push-plan";
import {
  cachePr,
  prForHead,
  prForNumber,
  alignPRs,
  prState,
} from "./lib/github";
import {
  getBookmarkPrefix,
  sanitizeBookmarkDescription,
  takenBookmarkNames,
  uniqueBookmarkName,
} from "./lib/bookmarks";
import {
  JJLogItemJsonSchema,
  RepoSchema,
  type PullRequest,
} from "./lib/schema";
import pkg from "./package.json";

import { jj, jjCommand, jjStdoutLines } from "./lib/jj";
import { lines, unique } from "./lib/utils";

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

// A push plan: `raw` is jj's own preview text (still what gets rendered --
// jj's wording is better than anything we'd reconstruct), `moves` is the
// same content parsed into structured PushMove records for callers that
// need to reason about individual ref updates (e.g. a future
// `jj-pr.allow` config gating confirmation per move kind).
interface PushPlan {
  raw: string;
  moves: PushMove[];
}

// Gather half: read-only. Returns the push plan, or null when jj reports
// nothing to push. Strips jj's dry-run disclaimer line from `raw`.
async function planPush(revset: string): Promise<PushPlan | null> {
  const output = await jj(`git push --dry-run -r '${revset}'`)
    .then(combineStdoutAndStderr)
    .then((s) => s.trim());
  if (output.endsWith("Nothing changed.")) return null;
  const raw = output.replace("\nDry-run requested, not pushing.", "");
  return { raw, moves: parsePushPreview(raw) };
}

// Gather half: read-only. `jj git push -r` only pushes bookmarks that already
// track the remote; a bookmark the user created locally and never pushed is
// skipped with a warning ("Refusing to create new remote bookmark ...") that
// still ends in "Nothing changed.", so planPush sees nothing to push and the
// later `gh pr create` fails with "Head ref must be a branch". Returns the
// subset of `names` that exist as local bookmarks but track no real remote
// (the `git` pseudo-remote doesn't count); those need an explicit
// `git push --bookmark`, which is allowed to create the remote ref.
async function untrackedLocalBookmarks(
  revset: string,
  names: string[],
): Promise<string[]> {
  if (names.length === 0) return [];
  const entries = await jjStdoutLines(
    `bookmark list --all-remotes -r '(${revset})' -T 'name ++ "\t" ++ remote ++ "\t" ++ if(remote, tracked, present) ++ "\n"'`,
  );
  const localPresent = new Set<string>();
  const tracked = new Set<string>();
  for (const entry of entries) {
    const [name, remote, flag] = entry.split("\t");
    if (!name || flag !== "true") continue;
    if (!remote) localPresent.add(name);
    else if (remote !== "git") tracked.add(name);
  }
  return names.filter(
    (name) => localPresent.has(name) && !tracked.has(name),
  );
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

// Resolves every change in the stack (oldest first) to the bookmark that
// will represent it, in one pass: an existing PR head wins, then a local
// bookmark, otherwise a name is invented. Names are reserved sequentially
// in stack order so a slug colliding with an existing bookmark (local or
// remote) or an earlier planned one gets a -2/-3/... suffix, rather than
// failing `git push --named` halfway through the stack.
async function resolveBookmarks(
  changes: string[],
): Promise<ResolvedBookmark[]> {
  const heads = await Promise.all(
    changes.map(async (change) => ({
      change,
      ...(await preferredBookmarkHead(change)),
    })),
  );

  const bookmarkPrefix = await getBookmarkPrefix();
  const taken = await takenBookmarkNames();
  const descriptions = new Map(
    await Promise.all(
      heads
        .filter(({ head }) => !head)
        .map(
          async ({ change }) =>
            [
              change,
              await execToSchema(
                JJLogItemJsonSchema,
                jjCommand(
                  `log -r ${shellQuote(change)} --no-graph -T 'json(self)'`,
                ),
              ),
            ] as const,
        ),
    ),
  );

  return heads.map(({ change, head, existingPr }): ResolvedBookmark => {
    if (head && existingPr) {
      return { kind: "pr", change, headBookmark: head, existingPr };
    }
    if (head) {
      return { kind: "local", change, headBookmark: head };
    }
    const item = descriptions.get(change)!;
    return {
      kind: "planned",
      change,
      headBookmark: uniqueBookmarkName(
        `${bookmarkPrefix}${sanitizeBookmarkDescription(item.description, item.change_id)}`,
        taken,
      ),
    };
  });
}

async function preferredProposedBookmarkHead(
  change: string,
  bookmarksAndPRs: ResolvedBookmark[],
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
      .filter((item) => item.kind === "planned")
      .map((item) => [item.change, item.headBookmark]),
  );
  const closestBookmarkChanges = await jjStdoutLines(
    `log --no-graph -r ${shellQuote(
      `heads(trunk()..${change}- & ${proposedBookmarkRevset(bookmarksAndPRs)}${excludeMerged})`,
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

async function createPrPlans(
  bookmarksAndPRs: ResolvedBookmark[],
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
    create: Extract<PRPlan, { action: "create" }>[];
    update: Extract<PRPlan, { action: "update" }>[];
    noop: Extract<PRPlan, { action: "noop" }>[];
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

export { unwrapHardWrappedText } from "./lib/github";

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
    const state = await prState(number);
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
  pushPreview: PushPlan | null; // from planPush
  rebases: MergedAncestorPr[]; // stranded stacks to rebase onto trunk first
  mergedTail: number[]; // merged ancestor PRs kept below the trunk line
  newBookmarks: PlannedBookmark[]; // named but NOT yet pushed
  untrackedHeads: string[]; // pre-existing local head bookmarks tracking no remote
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

  await Promise.all([
    ...plan.newBookmarks.map(async ({ headBookmark, change }) => {
      spinner.text = `pushing ${headBookmark}...`;
      await jj(`git push --named ${headBookmark}=${change}`);
    }),
    ...plan.untrackedHeads.map(async (name) => {
      spinner.text = `pushing ${name}...`;
      await jj(`git push --bookmark ${shellQuote(name)}`);
    }),
  ]);

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
  const detection = await detectMergedAncestors(userRevset, repo.nameWithOwner);

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
  const changes = await jjStdoutLines(
    `log --no-graph --reversed -r '(${revset}) & mutable()' -T 'change_id ++ "\n"'`,
  );

  if (!changes.length) {
    spinner.text = "nothing to do.";
    spinner.stopAndPersist();
    process.exit(0);
  }

  const bookmarksAndPRs = await resolveBookmarks(changes);
  const newBookmarks = bookmarksAndPRs.filter(
    (bookmark) => bookmark.kind === "planned",
  );

  spinner.text = "planning pr changes...";
  const prPlans = await createPrPlans(bookmarksAndPRs, trunk, excludeMerged);

  // this should never happen.
  if (prPlans.length === 0) {
    throw new Error("no plans to execute");
  }

  const newBookmarkNames = new Set(newBookmarks.map((b) => b.headBookmark));
  const untrackedHeads = await untrackedLocalBookmarks(
    revset,
    unique(prPlans.map((prPlan) => prPlan.headBookmark)).filter(
      (name) => !newBookmarkNames.has(name),
    ),
  );

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
    untrackedHeads,
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
    console.log(plan.pushPreview.raw);
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
  if (plan.untrackedHeads.length > 0) {
    console.log(
      `Local bookmarks not on the remote yet:\n${plan.untrackedHeads.join("\n")}`,
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
    plan.untrackedHeads.length === 0 &&
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
