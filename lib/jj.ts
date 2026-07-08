import { PROD_JJ_CONFIG } from "./config";
import { exec, execToSchema, mapToStdout, shellQuote, succeeds, combineStdoutAndStderr } from "./exec";
import { JJLogItemJsonSchema } from "./schema";
import { lines } from "./utils";

// All jj-pr commands run against the bundled config so the revset aliases in
// config.toml (closest_pushable, bookmark_heads_in_stack, ...) resolve. The
// file layers on top of the user's own jj config; it does not replace it.
export function jjCommand(
  args: string,
  configFile: string = PROD_JJ_CONFIG,
): string {
  return `jj --config-file ${configFile} ${args}`;
}

export function jj(args: string): Promise<{ stdout: string; stderr: string }> {
  return exec(jjCommand(args));
}

export function jjStdoutLines(args: string): Promise<string[]> {
  return jj(args).then(mapToStdout).then(lines);
}

// `jj config get` exits non-zero when the key is unset; that is the
// "no value" signal, not an error.
export async function configGet(key: string): Promise<string | undefined> {
  try {
    return (await jj(`config get ${shellQuote(key)}`).then(mapToStdout)).trim();
  } catch {
    return undefined;
  }
}

export function hasConfig(key: string): Promise<boolean> {
  return succeeds(jjCommand(`config get ${shellQuote(key)}`));
}

// Change ids in `revset`, one per line. `reversed` yields oldest-first
// (stack order).
export function changeIdsIn(
  revset: string,
  opts: { reversed?: boolean } = {},
): Promise<string[]> {
  const reversed = opts.reversed ? " --reversed" : "";
  return jjStdoutLines(
    `log --no-graph${reversed} -r ${shellQuote(revset)} -T 'change_id ++ "\n"'`,
  );
}

export function commitIdsIn(revset: string): Promise<string[]> {
  return jjStdoutLines(
    `log --no-graph -r ${shellQuote(revset)} -T 'commit_id ++ "\n"'`,
  );
}

// Bookmark names on the revisions in `revset`, remote bookmarks suffixed
// `@<remote>` (e.g. `feature@origin`), local ones bare.
export function bookmarksOn(revset: string): Promise<string[]> {
  return jjStdoutLines(
    `log -r ${shellQuote(revset)} --no-graph -T 'bookmarks.map(|b| b.name() ++ if(b.remote(), "@" ++ b.remote(), "")).join("\\n") ++ "\\n"'`,
  );
}

export function localBookmarksOn(revset: string): Promise<string[]> {
  return jjStdoutLines(
    `log -r ${shellQuote(revset)} --no-graph -T 'local_bookmarks.map(|b| b.name()).join("\\n") ++ "\\n"'`,
  );
}

export function allBookmarkNames(): Promise<string[]> {
  return jjStdoutLines(`bookmark list --all-remotes -T 'name ++ "\\n"'`);
}

export function bookmarkNamesIn(revset: string): Promise<string[]> {
  return jjStdoutLines(
    `bookmark list -r ${shellQuote(revset)} -T 'name ++ "\n"'`,
  );
}

// Full commit metadata for a single revision, via jj's stable json(self)
// template.
export function logItem(change: string) {
  return execToSchema(
    JJLogItemJsonSchema,
    jjCommand(`log -r ${shellQuote(change)} --no-graph -T 'json(self)'`),
  );
}

export async function gitFetch(): Promise<void> {
  await jj(`git fetch`);
}

// Dry-run push preview for `revset`: the human-readable summary jj prints,
// or null when jj reports nothing to push. Strips the dry-run disclaimer.
export async function pushPreview(revset: string): Promise<string | null> {
  const output = await jj(`git push --dry-run -r ${shellQuote(revset)}`)
    .then(combineStdoutAndStderr)
    .then((s) => s.trim());
  if (output.endsWith("Nothing changed.")) return null;
  return output.replace("\nDry-run requested, not pushing.", "");
}

// Combined stdout+stderr because jj reports push refusals as warnings on
// stderr with exit 0; callers inspect the text.
export function gitPush(revset: string): Promise<string> {
  return jj(`git push -r ${shellQuote(revset)}`).then(combineStdoutAndStderr);
}

export async function gitPushNamed(
  bookmark: string,
  change: string,
): Promise<void> {
  await jj(`git push --named ${bookmark}=${change}`);
}

// Rebase everything stranded above a merged head onto trunk. The command
// string is exposed separately so the confirm prompt can show exactly what
// will run.
export function rebaseOntoTrunkArgs(headRefOid: string): string {
  return `rebase -s ${shellQuote(`${headRefOid}+ & mutable()`)} -d 'trunk()'`;
}

export async function rebaseOntoTrunk(headRefOid: string): Promise<void> {
  await jj(rebaseOntoTrunkArgs(headRefOid));
}

// Short ids, for human-readable conflict reporting.
export function conflictedChangeIdsIn(revset: string): Promise<string[]> {
  return jjStdoutLines(
    `log --no-graph -r ${shellQuote(`(${revset}) & conflicts()`)} -T 'change_id.short() ++ "\n"'`,
  );
}

// Runs the user's configured fix tools across the mutable part of `revset`.
export async function fix(revset: string): Promise<void> {
  await jj(`fix -s ${shellQuote(`(${revset}) & mutable()`)}`);
}
