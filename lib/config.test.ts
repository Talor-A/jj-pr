import { describe, it, expect } from "bun:test";
import fs from "node:fs";
import { PROD_JJ_CONFIG, TEST_JJ_CONFIG } from "./config";

describe("config", () => {
  it("resolves prod config", () => {
    expect(PROD_JJ_CONFIG).toBeDefined();
    expect(fs.existsSync(PROD_JJ_CONFIG)).toBe(true);
  });
  it("resolves test config", () => {
    expect(TEST_JJ_CONFIG).toBeDefined();
    expect(fs.existsSync(TEST_JJ_CONFIG)).toBe(true);
  });
});
