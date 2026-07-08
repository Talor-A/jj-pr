import { PROD_JJ_CONFIG } from "./config";
import { exec, mapToStdout, shellQuote, succeeds } from "./exec";
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
