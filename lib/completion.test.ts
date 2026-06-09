import { describe, expect, test } from "bun:test";
import { completionScript, isShell, SHELLS } from "./completion";

describe("completion", () => {
  test("SHELLS covers bash, zsh, fish", () => {
    expect([...SHELLS]).toEqual(["bash", "zsh", "fish"]);
  });

  test("isShell accepts supported shells", () => {
    for (const shell of SHELLS) {
      expect(isShell(shell)).toBe(true);
    }
  });

  test("isShell rejects unsupported values", () => {
    expect(isShell("powershell")).toBe(false);
    expect(isShell("")).toBe(false);
  });

  for (const shell of SHELLS) {
    test(`${shell} script mentions jj-pr and the revision flag`, () => {
      const script = completionScript(shell);
      expect(script).toContain("jj-pr");
      expect(script).toContain("revision");
    });

    test(`${shell} script matches snapshot`, () => {
      expect(completionScript(shell)).toMatchSnapshot();
    });
  }
});
