import { describe, expect, test } from "bun:test";
import { execWithStdin, shellQuote } from "./exec";

describe("shellQuote", () => {
  test("wraps simple revsets in single quotes", () => {
    expect(shellQuote("@")).toBe("'@'");
    expect(shellQuote("mykpnrqw")).toBe("'mykpnrqw'");
  });

  test("quotes revsets with parentheses", () => {
    expect(shellQuote("closest_bookmark(mykpnrqwkvyxuzqqntuulzxwsrvxlkxm-)")).toBe(
      "'closest_bookmark(mykpnrqwkvyxuzqqntuulzxwsrvxlkxm-)'",
    );
  });

  test("escapes embedded single quotes", () => {
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
  });
});

describe("execWithStdin", () => {
  test("writes stdin and closes it so the child process can exit", async () => {
    const { stdout } = await execWithStdin("cat", "## PR Stack\n- `master`\n");
    expect(stdout).toBe("## PR Stack\n- `master`\n");
  });
});
