import { PROD_JJ_CONFIG } from "./config";
import { exec, mapToStdout, shellQuote } from "./exec";
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

// `config get` exits nonzero when a key is unset, which makes it tempting for
// callers to catch every failure. `config list` represents an unset key as an
// empty stdout instead, while real config/repository failures still reject.
export async function jjConfigString(
  name: string,
): Promise<string | undefined> {
  const output = await jj(
    `--ignore-working-copy config list ${shellQuote(name)} ` +
      `-T 'value.as_string() ++ "\\n"'`,
  ).then(mapToStdout);
  return output.trim() || undefined;
}

export function parseUnintegratedOperationId(
  stderr: string,
): string | undefined {
  return stderr.match(
    /^Operation left uncommitted because --no-integrate-operation was requested: ([0-9a-f]+)$/m,
  )?.[1];
}
