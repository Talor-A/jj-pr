/**
 * this function returns both:
 * * bookmarks that are pushable
 * * the closest pushable commit to the provided commit
 *
 * thus, each returned change in the revset either has a bookmark assigned to it,
 * or needs a new bookmark created.
 */
export function constructRevset(maybeNewCommitToPush: string): string {
  return `bookmark_heads_in_stack(${maybeNewCommitToPush}) | closest_pushable(${maybeNewCommitToPush})`;
}
export const DEFAULT_LOG_REVSET =
  "present(@) | ancestors(immutable_heads().., 2) | trunk()";
