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
  closestBookmarkBeforeChangeRevset,
  jjLogBookmarksCommand,
  mergeBookmarkResults,
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

const PR_STACK_SECTION_PATTERN =
  /(?:^|\n)(?:<!-- GENERATED_PR_STACK -->\n)?## PR Stack\n\n?(?:- .+(?:\n|$))+/m;

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
  const stripped = body.replace(PR_STACK_SECTION_PATTERN, "").trimEnd();

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

  return { head: bookmarkHeads[0] };
}

function sanitizeBookmarkDescription(
  description: string,
  fallback: string,
): string {
  const slug = (description || fallback)
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

type BookmarkResult =
  | { headBookmark: string; existingPr: PullRequest; change: string }
  | {
      headBookmark: string;
      existingPr: undefined;
      change: string;
    }
  | {
      headBookmark: undefined;
      existingPr: undefined;
      change: string;
    };

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

async function approveAndPushNewBookmarks(
  spinner: Ora,
  dryRun: boolean,
  bookmarksAndPRs: BookmarkResult[],
  approvedNewBookmarks: Set<string>,
) {
  const bookmarkPrefix = await getBookmarkPrefix();
  const changesNeedingBookmarks = await Promise.all(
    bookmarksAndPRs
      .filter((change) => !change.headBookmark)
      .map(async ({ change, ...item }) => {
        const changeitem = await execToSchema(
          JJLogItemJsonSchema,
          `jj --config-file ${jjconf} log -r ${shellQuote(change)} --no-graph -T 'json(self)'`,
        );

        return {
          change,
          ...item,
          headBookmark: `${bookmarkPrefix}${sanitizeBookmarkDescription(changeitem.description, changeitem.change_id)}`,
          new: true as const,
        };
      }),
  );
  const newBookmarks = changesNeedingBookmarks
    .filter((bookmark) => bookmark.new)
    .map((b) => b.headBookmark);
  if (newBookmarks.length === 0)
    return bookmarksAndPRs as (
      | { headBookmark: string; existingPr: PullRequest; change: string }
      | {
          headBookmark: string;
          existingPr: undefined;
          change: string;
        }
    )[];
  spinner.stop();
  console.log(`New bookmarks:\n${newBookmarks.join("\n")}`);

  if (dryRun) {
    console.log("dry run: skipping push.");
    process.exit(0);
  }
  const shouldPush = await confirm("push new bookmarks? (⏎ / n)");
  if (!shouldPush) {
    process.exit(0);
  }
  spinner.start();
  await Promise.all(
    changesNeedingBookmarks
      .filter((bookmark) => bookmark.new)
      .map(async ({ headBookmark, change }) => {
        spinner.text = `pushing ${headBookmark}...`;
        approvedNewBookmarks.add(headBookmark);
        await exec(
          `jj --config-file ${jjconf} git push --named ${headBookmark}=${change}`,
        );
      }),
  );

  const locallyBookmarked = await Promise.all(
    bookmarksAndPRs.map(async (item): Promise<BookmarkResult> => {
      if (!item.headBookmark) return item;
      const localHeads = await localBookmarkHeadsForChange(item.change);
      if (
        localHeads.includes(item.headBookmark) &&
        item.headBookmark.startsWith(bookmarkPrefix)
      ) {
        return item;
      }
      return {
        change: item.change,
        headBookmark: undefined,
        existingPr: undefined,
      };
    }),
  );

  return mergeBookmarkResults(locallyBookmarked, changesNeedingBookmarks);
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
  bookmarksAndPRs: (
    | { headBookmark: string; existingPr: PullRequest; change: string }
    | { headBookmark: string; existingPr: undefined; change: string }
  )[],
  trunk: string,
): Promise<PRPlan[]> {
  const plans = await Promise.all(
    bookmarksAndPRs.map(
      async ({ headBookmark, existingPr, change }): Promise<PRPlan> => {
        const baseBranch =
          (
            await preferredBookmarkHead(
              closestBookmarkBeforeChangeRevset(change),
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
      await exec(
        `gh pr create --head ${headBookmark} --base ${baseBranch} --draft --fill`,
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

export async function main(spinner: Ora, args: CliArgs) {
  const trunk = await ensureTrunk();
  const gitDir = await absoluteGitDir();

  await doFetch(spinner);

  if (args.rebase) {
    await doRebase(spinner, args.dryRun, gitDir);
  }

  const revset = constructRevset(args.revision);

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

  const stackMarkdown = `${stackLines.join("\n")}\n`;
  spinner.stop();

  spinner.text = "updating descriptions...";
  spinner.start();

  await Promise.allSettled(
    changes.map(async (change) => {
      const number = prInfo.get(change)?.number;
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
