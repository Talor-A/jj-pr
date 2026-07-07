import { describe, expect, test } from "bun:test";
import { jjCommand } from "./jj";
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
