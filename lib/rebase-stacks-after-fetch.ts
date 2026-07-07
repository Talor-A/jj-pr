import { z } from "zod";
import { saveRebaseState } from "./rebase-state";
import { exec, mapToStdout, shellQuote } from "./exec";

type Operation = {
  id: string;
  args: string;
  parents: string[];
};

const OperationJsonSchema = z.object({
  id: z.string(),
  parents: z.array(z.string()),
  attributes: z.object({ args: z.string().optional() }).optional(),
});

const BookmarkJsonSchema = z.object({
  name: z.string(),
  remote: z.string().optional(),
  target: z.array(z.string()).optional(),
});

type BookmarkJson = z.infer<typeof BookmarkJsonSchema>;

export type AbandonedBookmark = {
  name: string;
  previousCommit: string;
};

export type RebasePlan = {
  bookmark: AbandonedBookmark;
  roots: string[];
};

function lines(value: string): string[] {
  return value.split(/\r?\n/).filter((line) => line.length > 0);
}

function parseJsonLines<T>(schema: z.ZodType<T>, value: string): T[] {
  return lines(value).map((line) => schema.parse(JSON.parse(line)));
}

function parseOperations(opLog: string): Operation[] {
  return parseJsonLines(OperationJsonSchema, opLog).map((operation) => ({
    id: operation.id,
    args: operation.attributes?.args ?? "",
    parents: operation.parents,
  }));
}

export async function getCurrentOperationId(): Promise<string> {
  const id = lines(
    await exec(
      `jj op log --ignore-working-copy --at-op=@ -n 1 --no-graph -T 'self.id() ++ "\\n"'`,
    ).then(mapToStdout),
  )[0];

  if (!id) {
    throw new Error("Unable to determine current jj operation");
  }

  return id;
}

export async function opLogIds(limit: number = 1000): Promise<string[]> {
  return lines(
    await exec(
      `jj op log --ignore-working-copy --at-op=@ -n ${String(limit)} --no-graph -T 'self.id() ++ "\\n"'`,
    ).then(mapToStdout),
  );
}

async function operationsSince(
  beforeOpId: string,
  currentOpId: string,
): Promise<Operation[]> {
  const opLog = await exec(
    `jj op log --ignore-working-copy --at-op=${currentOpId} -n 1000 --no-graph --color=never -T 'json(self) ++ "\\n"'`,
  ).then(mapToStdout);
  const operations = parseOperations(opLog);
  const beforeIndex = operations.findIndex(
    (operation) => operation.id === beforeOpId,
  );

  if (beforeIndex === -1) {
    fail(`Operation not found in current history: ${beforeOpId}`);
  }

  return operations.slice(0, beforeIndex).reverse();
}

export function resolveRebaseCheckpoint(
  lastCheckedOp: string | null | undefined,
  currentOp: string,
  opLogFromCurrent: string[],
): { beforeOp: string | null; stalePointer: boolean } {
  if (!lastCheckedOp || lastCheckedOp === currentOp) {
    return { beforeOp: null, stalePointer: false };
  }

  if (!opLogFromCurrent.includes(lastCheckedOp)) {
    return { beforeOp: null, stalePointer: true };
  }

  return { beforeOp: lastCheckedOp, stalePointer: false };
}

async function localBookmarksAt(
  operation: string,
): Promise<Map<string, BookmarkJson>> {
  const output = await exec(
    `jj --at-op ${operation} bookmark list --color=never -T 'json(self) ++ "\\n"'`,
  ).then(mapToStdout);
  return new Map(
    parseJsonLines(BookmarkJsonSchema, output)
      .filter((bookmark) => bookmark.remote === undefined)
      .map((bookmark) => [bookmark.name, bookmark]),
  );
}

async function trunkCommitAt(operation: string): Promise<string | undefined> {
  const output = await exec(
    `jj --at-op ${operation} log --no-graph -r 'trunk()' -T 'commit_id ++ "\\n"'`,
  ).then(mapToStdout);
  return lines(output)[0];
}

function isFetchOperation(operation: Operation): boolean {
  return /(?:^|\s)git fetch(?:\s|$)/.test(operation.args);
}

function removedBookmarks(
  before: Map<string, BookmarkJson>,
  after: Map<string, BookmarkJson>,
): AbandonedBookmark[] {
  const removed: AbandonedBookmark[] = [];
  for (const [name, bookmark] of before) {
    const previousCommit = bookmark.target?.[0];
    if (previousCommit === undefined || after.has(name)) {
      continue;
    }

    removed.push({ name, previousCommit });
  }
  return removed;
}

export async function findBookmarksRemovedByMergeFetchSince(
  beforeOpId: string,
  currentOpId: string,
): Promise<AbandonedBookmark[]> {
  const operations = await operationsSince(beforeOpId, currentOpId);
  let previousBookmarks = await localBookmarksAt(beforeOpId);
  let previousTrunk = await trunkCommitAt(beforeOpId);
  const removedByName = new Map<string, AbandonedBookmark>();

  for (const operation of operations) {
    const currentBookmarks = await localBookmarksAt(operation.id);
    const currentTrunk = await trunkCommitAt(operation.id);

    if (
      isFetchOperation(operation) &&
      previousTrunk !== undefined &&
      currentTrunk !== undefined &&
      previousTrunk !== currentTrunk
    ) {
      for (const removed of removedBookmarks(
        previousBookmarks,
        currentBookmarks,
      )) {
        removedByName.set(removed.name, removed);
      }
    }

    previousBookmarks = currentBookmarks;
    previousTrunk = currentTrunk;
  }

  return [...removedByName.values()].filter(
    (bookmark) => !previousBookmarks.has(bookmark.name),
  );
}

export async function findAbandonedBookmarksSince(
  lastCheckedOp: string | null,
): Promise<{
  abandoned: AbandonedBookmark[];
  currentOp: string;
  stalePointer: boolean;
}> {
  const currentOp = await getCurrentOperationId();
  const opLog = await opLogIds();
  const { beforeOp, stalePointer } = resolveRebaseCheckpoint(
    lastCheckedOp,
    currentOp,
    opLog,
  );

  if (!beforeOp) {
    return { abandoned: [], currentOp, stalePointer };
  }

  const abandoned = await findBookmarksRemovedByMergeFetchSince(
    beforeOp,
    currentOp,
  );
  return { abandoned, currentOp, stalePointer };
}

export function stackRootsRevset(commit: string): string {
  return `roots((${commit}:: & mutable()) ~ ${commit})`;
}

export function jjStackRootsLogCommand(revset: string): string {
  return `jj log --no-graph -r ${shellQuote(revset)} -T 'change_id ++ "\\n"'`;
}

export async function stackRootsAbove(commit: string): Promise<string[]> {
  return lines(
    await exec(jjStackRootsLogCommand(stackRootsRevset(commit))).then(
      mapToStdout,
    ),
  );
}

export async function planRebasesFromAbandoned(
  abandoned: AbandonedBookmark[],
): Promise<RebasePlan[]> {
  return (
    await Promise.all(
      abandoned.map(async (bookmark) => ({
        bookmark,
        roots: await stackRootsAbove(bookmark.previousCommit),
      })),
    )
  ).filter((plan) => plan.roots.length > 0);
}

export async function saveRebaseCheckpoint(gitDir: string): Promise<void> {
  await saveRebaseState(gitDir, await getCurrentOperationId());
}

function fail(message: string): never {
  throw new Error(message);
}
