import { PROD_JJ_CONFIG } from "./config";
import { shellQuote } from "./exec";
import type { PullRequest } from "./schema";

export function closestBookmarkBeforeChangeRevset(change: string): string {
  return `closest_bookmark(${change}-)`;
}

export function jjLogBookmarksCommand(
  revset: string,
  configFile: string = PROD_JJ_CONFIG,
): string {
  return `jj --config-file ${configFile} log -r ${shellQuote(revset)} --no-graph -T 'bookmarks.map(|b| b.name() ++ if(b.remote(), "@" ++ b.remote(), "")).join("\\n") ++ "\\n"'`;
}

// One entry per change in the stack, oldest first, answering: which
// bookmark represents this change on GitHub?
//   pr      — an existing bookmark that already has an open PR
//   local   — an existing local bookmark, pushable but PR-less
//   planned — no usable bookmark; jj-pr invented a name (not yet pushed)
export type ResolvedBookmark =
  | { kind: "pr"; change: string; headBookmark: string; existingPr: PullRequest }
  | { kind: "local"; change: string; headBookmark: string; existingPr?: undefined }
  | { kind: "planned"; change: string; headBookmark: string; existingPr?: undefined };

export type PlannedBookmark = Extract<ResolvedBookmark, { kind: "planned" }>;

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
export type PRPlan = PRPlanCreate | PRPlanUpdate | PRPlanNoop;

export interface StackEntry {
  change: string;
  headBookmark: string;
  prNumber?: number; // absent until the PR exists
}

// Matches a generated "## PR Stack" section and the bullet list that follows.
// Global so every prior section is stripped (a body that already accumulated
// duplicates self-heals), and tolerant of trailing heading whitespace and
// extra blank lines after the heading. Bodies are normalized to LF before
// this runs, since GitHub returns PR bodies with CRLF.
export const PR_STACK_SECTION_PATTERN =
  /(?:^|\n)(?:<!-- GENERATED_PR_STACK -->\n)?## PR Stack[ \t]*\n\n*(?:- .+(?:\n|$))+/gm;

export interface ParsedPrStack {
  above: number[]; // PRs listed above the trunk line: the live stack
  below: number[]; // merged PRs carried below the trunk line
}

// Reads PR numbers back out of a previously generated section, split at the
// trunk line. Only GitHub pull URLs count; `[new PR] ...` placeholders and
// the trunk line itself are structural. Returns undefined when the body has
// no section.
export function parsePrStackSection(body: string): ParsedPrStack | undefined {
  const sections = body.replace(/\r\n/g, "\n").match(PR_STACK_SECTION_PATTERN);
  const section = sections?.[sections.length - 1];
  if (section === undefined) return undefined;

  const numbersIn = (bullets: string[]) =>
    bullets.flatMap((line) => {
      const url = line.match(/\/pull\/(\d+)\s*$/);
      return url ? [Number(url[1])] : [];
    });

  const bullets = section.split("\n").filter((line) => line.startsWith("- "));
  const trunkIndex = bullets.findIndex((line) => /^- `[^`]+`$/.test(line));
  if (trunkIndex === -1) return { above: numbersIn(bullets), below: [] };
  return {
    above: numbersIn(bullets.slice(0, trunkIndex)),
    below: numbersIn(bullets.slice(trunkIndex + 1)),
  };
}

// Renders the "## PR Stack" section. Entries arrive oldest-first (stack
// order); the section lists newest-first, ending at trunk. Merged ancestor
// PRs stay listed below the trunk line -- their content landed in trunk, and
// GitHub renders the bare URLs with the purple merged badge.
export function renderStackMarkdown(
  entries: StackEntry[],
  trunk: string,
  nameWithOwner: string,
  mergedTail: number[] = [],
): string {
  const lines = ["## PR Stack"];
  for (const entry of [...entries].reverse()) {
    lines.push(
      entry.prNumber !== undefined
        ? `- https://github.com/${nameWithOwner}/pull/${entry.prNumber}`
        : `- [new PR] ${entry.headBookmark}`,
    );
  }
  lines.push(`- \`${trunk}\``);
  for (const number of mergedTail) {
    lines.push(`- https://github.com/${nameWithOwner}/pull/${number}`);
  }
  return `${lines.join("\n")}\n`;
}

// Revset of base-branch candidates: real bookmarks plus changes whose
// bookmarks are only planned (not yet pushed, e.g. during a dry run). With no
// planned changes this degenerates to `bookmarks()`, so
// `heads(trunk()..X & proposedBookmarkRevset(...))` stays equivalent to the
// `closest_bookmark(X)` alias in config.toml.
export function proposedBookmarkRevset(
  bookmarks: ResolvedBookmark[],
): string {
  const plannedNewChanges = bookmarks
    .filter((item) => item.kind === "planned")
    .map((item) => item.change);
  if (plannedNewChanges.length === 0) return "bookmarks()";
  return `(bookmarks() | ${plannedNewChanges.join(" | ")})`;
}
