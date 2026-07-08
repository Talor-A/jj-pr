import { exec, execToSchema, mapToStdout, shellQuote } from "./exec";
import { prForHead } from "./github";
import { jj, jjCommand, jjStdoutLines } from "./jj";
import {
  jjLogBookmarksCommand,
  proposedBookmarkRevset,
  type ResolvedBookmark,
} from "./pr-stack";
import { JJLogItemJsonSchema, type PullRequest } from "./schema";
import { lines, unique } from "./utils";

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

// Resolves every change in the stack (oldest first) to the bookmark that
// will represent it, in one pass: an existing PR head wins, then a local
// bookmark, otherwise a name is invented. Names are reserved sequentially
// in stack order so a slug colliding with an existing bookmark (local or
// remote) or an earlier planned one gets a -2/-3/... suffix, rather than
// failing `git push --named` halfway through the stack.
export async function resolveBookmarks(
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

export async function preferredProposedBookmarkHead(
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
    )} -T 'change_id ++ "\\n"'`,
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
