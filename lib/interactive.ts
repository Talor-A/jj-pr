import { fstatSync } from "node:fs";
import { stdin } from "node:process";

export function canPromptInteractively(
  input: typeof stdin = stdin,
): boolean {
  return input.isTTY === true;
}

function stdinIsRedirected(stat: ReturnType<typeof fstatSync>): boolean {
  return stat.isFIFO() || stat.isFile();
}

export function hasPipedStdin(input: typeof stdin = stdin): boolean {
  if (input.isTTY === true) return false;
  if (input.readableEnded) return false;
  try {
    return stdinIsRedirected(fstatSync(0));
  } catch {
    return false;
  }
}

export function canReadConfirmation(input: typeof stdin = stdin): boolean {
  return canPromptInteractively(input) || hasPipedStdin(input);
}

export const NON_INTERACTIVE_MESSAGE =
  "Not running in an interactive terminal. Use --yes to confirm or --dry-run to preview.";
