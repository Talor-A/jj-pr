import { mapToStdout } from "./exec";
import { jj, jjStdoutLines } from "./jj";

let _bookmarkPrefix: string | undefined;
// Resolved bookmark prefix for newly-created bookmarks. Prefers the
// `jj-pr.bookmark-prefix` config key (layered from the user's jj config),
// falling back to `<user>/jj/` derived from `user.email`.
export async function getBookmarkPrefix(): Promise<string> {
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

export function sanitizeBookmarkDescription(
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

export async function takenBookmarkNames(): Promise<Set<string>> {
  return new Set(
    await jjStdoutLines(`bookmark list --all-remotes -T 'name ++ "\\n"'`),
  );
}

export function uniqueBookmarkName(base: string, taken: Set<string>): string {
  let name = base;
  for (let suffix = 2; taken.has(name); suffix++) {
    name = `${base}-${suffix}`;
  }
  taken.add(name);
  return name;
}
