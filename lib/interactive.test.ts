import { describe, expect, test } from "bun:test";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { stdin } from "node:process";
import {
  canPromptInteractively,
  canReadConfirmation,
  hasPipedStdin,
} from "./interactive";

describe("interactive stdin detection", () => {
  test("canPromptInteractively is true only for a TTY", () => {
    const tty = { isTTY: true, readableEnded: false } as typeof stdin;
    const nonTTY = { isTTY: undefined, readableEnded: false } as unknown as typeof stdin;
    expect(canPromptInteractively(tty)).toBe(true);
    expect(canPromptInteractively(nonTTY)).toBe(false);
  });

  test("hasPipedStdin is true for a FIFO pipe", async () => {
    const proc = Bun.spawn(
      [
        "sh",
        "-c",
        `yes "" | bun -e "import { hasPipedStdin } from './lib/interactive.ts'; console.log(hasPipedStdin())"`,
      ],
      {
        cwd: import.meta.dirname + "/..",
        stdout: "pipe",
      },
    );
    expect(await new Response(proc.stdout).text()).toBe("true\n");
    expect(await proc.exited).toBe(0);
  });

  test("hasPipedStdin is true for a redirected file", async () => {
    const inputPath = join(import.meta.dirname, "interactive-test-input.txt");
    await writeFile(inputPath, "\n");
    const proc = Bun.spawn(
      [
        "sh",
        "-c",
        `bun -e "import { hasPipedStdin } from './lib/interactive.ts'; console.log(hasPipedStdin())" < "${inputPath}"`,
      ],
      {
        cwd: import.meta.dirname + "/..",
        stdout: "pipe",
      },
    );
    expect(await new Response(proc.stdout).text()).toBe("true\n");
    expect(await proc.exited).toBe(0);
    await rm(inputPath);
  });

  test("hasPipedStdin is false when stdin is ignored", async () => {
    const proc = Bun.spawn(
      [
        "bun",
        "-e",
        "import { hasPipedStdin } from './lib/interactive.ts'; console.log(hasPipedStdin())",
      ],
      {
        cwd: import.meta.dirname + "/..",
        stdin: "ignore",
        stdout: "pipe",
      },
    );
    expect(await new Response(proc.stdout).text()).toBe("false\n");
    expect(await proc.exited).toBe(0);
  });

  test("canReadConfirmation is false for ignored stdin", async () => {
    const proc = Bun.spawn(
      [
        "bun",
        "-e",
        "import { canReadConfirmation } from './lib/interactive.ts'; console.log(canReadConfirmation())",
      ],
      {
        cwd: import.meta.dirname + "/..",
        stdin: "ignore",
        stdout: "pipe",
      },
    );
    expect(await new Response(proc.stdout).text()).toBe("false\n");
    expect(await proc.exited).toBe(0);
  });
});
