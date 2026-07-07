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

export type BookmarkResult =
  | {
      headBookmark: string;
      existingPr: PullRequest;
      change: string;
      new?: true;
    }
  | {
      headBookmark: string;
      existingPr: undefined;
      change: string;
      new?: true;
    }
  | {
      headBookmark: undefined;
      existingPr: undefined;
      change: string;
    };

export type BookmarkResultWithHead = Extract<
  BookmarkResult,
  { headBookmark: string }
>;

export interface StackEntry {
  change: string;
  headBookmark: string;
  prNumber?: number; // absent until the PR exists
}

// Renders the "## PR Stack" section. Entries arrive oldest-first (stack
// order); the section lists newest-first, ending at trunk.
export function renderStackMarkdown(
  entries: StackEntry[],
  trunk: string,
  nameWithOwner: string,
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
  return `${lines.join("\n")}\n`;
}

// Revset of base-branch candidates: real bookmarks plus changes whose
// bookmarks are only planned (not yet pushed, e.g. during a dry run). With no
// planned changes this degenerates to `bookmarks()`, so
// `heads(trunk()..X & proposedBookmarkRevset(...))` stays equivalent to the
// `closest_bookmark(X)` alias in config.toml.
export function proposedBookmarkRevset(
  bookmarksAndPRs: BookmarkResultWithHead[],
): string {
  const plannedNewChanges = bookmarksAndPRs
    .filter((item) => item.new)
    .map((item) => item.change);
  if (plannedNewChanges.length === 0) return "bookmarks()";
  return `(bookmarks() | ${plannedNewChanges.join(" | ")})`;
}

export function existingBookmarkResults(
  bookmarksAndPRs: BookmarkResult[],
): BookmarkResultWithHead[] {
  return bookmarksAndPRs.filter(
    (item): item is BookmarkResultWithHead => item.headBookmark !== undefined,
  );
}

export function mergeBookmarkResults(
  bookmarksAndPRs: BookmarkResult[],
  newlyPrepared: BookmarkResultWithHead[],
): BookmarkResultWithHead[] {
  return [...existingBookmarkResults(bookmarksAndPRs), ...newlyPrepared];
}
