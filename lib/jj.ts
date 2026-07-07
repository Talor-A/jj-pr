import { PROD_JJ_CONFIG } from "./config";
import { exec, mapToStdout } from "./exec";
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
