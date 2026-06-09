import { join } from "node:path";
import { z } from "zod";
import { exec, mapToStdout } from "./exec";
import fs from "node:fs/promises";

const RebaseStateSchema = z.object({
  version: z.literal(1),
  lastCheckedOp: z.string(),
});

export type RebaseState = z.infer<typeof RebaseStateSchema>;

export function rebaseStatePath(gitDir: string): string {
  return join(gitDir, "jj-ts-state.json");
}

export async function absoluteGitDir(): Promise<string> {
  return exec("git rev-parse --absolute-git-dir")
    .then(mapToStdout)
    .then((s) => s.trim());
}

export async function loadRebaseState(
  gitDir: string,
): Promise<RebaseState | null> {
  if (!(await fs.exists(rebaseStatePath(gitDir)))) {
    return null;
  }

  return RebaseStateSchema.parse(
    JSON.parse(await fs.readFile(rebaseStatePath(gitDir), "utf8")),
  );
}

export async function saveRebaseState(
  gitDir: string,
  lastCheckedOp: string,
): Promise<void> {
  const state: RebaseState = { version: 1, lastCheckedOp };
  await fs.writeFile(
    rebaseStatePath(gitDir),
    `${JSON.stringify(state, null, 2)}\n`,
  );
}
