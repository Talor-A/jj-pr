import { describe, expect, test } from "bun:test";
import { jjCommand, parseUnintegratedOperationId } from "./jj";
import { PROD_JJ_CONFIG } from "./config";

describe("jjCommand", () => {
  test("defaults to the bundled prod config", () => {
    expect(jjCommand("log -r x")).toBe(
      `jj --config-file ${PROD_JJ_CONFIG} log -r x`,
    );
  });

  test("accepts an explicit config file", () => {
    expect(jjCommand("log", "/tmp/other.toml")).toBe(
      "jj --config-file /tmp/other.toml log",
    );
  });
});

describe("parseUnintegratedOperationId", () => {
  test("extracts the operation id from jj's stderr", () => {
    expect(
      parseUnintegratedOperationId(
        "Rebased 1 commits to destination.\n" +
          "Operation left uncommitted because --no-integrate-operation was requested: c3ecd765f58f\n",
      ),
    ).toBe("c3ecd765f58f");
  });

  test("returns undefined when jj did not create an operation", () => {
    expect(
      parseUnintegratedOperationId("No revisions to rebase.\n"),
    ).toBeUndefined();
  });
});
