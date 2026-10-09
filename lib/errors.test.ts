import { describe, expect, test } from "bun:test";
import { CliError, reportError } from "./errors";
import { CommandError } from "./exec";

function capture(error: unknown): { output: string; exitCode: number } {
  let output = "";
  const exitCode = reportError(error, (chunk) => {
    output += chunk;
  });
  return { output, exitCode };
}

describe("reportError", () => {
  test("writes command stderr without the wrapper error or stack", () => {
    const failure = new CommandError(
      "jj status",
      7,
      "ignored stdout",
      "Error: working copy is stale\nHint: update it\n",
    );

    expect(capture(failure)).toEqual({
      output: "Error: working copy is stale\nHint: update it\n",
      exitCode: 7,
    });
  });

  test("falls back to command stdout and adds a trailing newline", () => {
    const failure = new CommandError("tool", 2, "failure on stdout", "");

    expect(capture(failure)).toEqual({
      output: "failure on stdout\n",
      exitCode: 2,
    });
  });

  test("writes controlled CLI errors without a stack", () => {
    expect(capture(new CliError("Invalid arguments"))).toEqual({
      output: "Invalid arguments\n",
      exitCode: 1,
    });
  });

  test("keeps the stack for unexpected errors", () => {
    const result = capture(new Error("unexpected"));

    expect(result.exitCode).toBe(1);
    expect(result.output).toStartWith("Error: unexpected\n");
    expect(result.output).toContain("at ");
  });
});
