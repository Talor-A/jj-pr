import { CommandError } from "./exec";

export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode: number = 1,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "CliError";
  }
}

type ErrorWriter = (output: string) => void;

function withTrailingNewline(output: string): string {
  return output.endsWith("\n") ? output : `${output}\n`;
}

export function reportError(
  error: unknown,
  write: ErrorWriter = (output) => process.stderr.write(output),
): number {
  if (error instanceof CommandError) {
    write(withTrailingNewline(error.stderr || error.stdout || error.message));
    return error.exitCode || 1;
  }

  if (error instanceof CliError) {
    write(withTrailingNewline(error.message));
    return error.exitCode;
  }

  const output =
    error instanceof Error ? error.stack ?? error.message : String(error);
  write(withTrailingNewline(output));
  return 1;
}
