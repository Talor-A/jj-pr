import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadRebaseState,
  rebaseStatePath,
  saveRebaseState,
} from "./rebase-state";

describe("rebase state", () => {
  test("round-trips lastCheckedOp in the git dir", async () => {
    const gitDir = await mkdtemp(join(tmpdir(), "jj-pr-state-"));
    try {
      const opId = "abc123checkpoint";
      await saveRebaseState(gitDir, opId);
      expect(await loadRebaseState(gitDir)).toEqual({
        version: 1,
        lastCheckedOp: opId,
      });
      expect(rebaseStatePath(gitDir)).toBe(join(gitDir, "jj-pr-state.json"));
    } finally {
      await rm(gitDir, { recursive: true, force: true });
    }
  });
});
