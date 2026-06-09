import { shellQuote } from "./exec";
import type { PullRequest } from "./schema";

export function closestBookmarkBeforeChangeRevset(change: string): string {
  return `closest_bookmark(${change}-)`;
}

export function jjLogBookmarksCommand(
  configFile: string,
  revset: string,
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
