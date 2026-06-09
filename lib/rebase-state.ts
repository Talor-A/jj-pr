import { join } from "node:path";
import { z } from "zod";
import { exec, mapToStdout } from "./exec";

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
  const file = Bun.file(rebaseStatePath(gitDir));
  if (!(await file.exists())) {
    return null;
  }

  return RebaseStateSchema.parse(await file.json());
}

export async function saveRebaseState(
  gitDir: string,
  lastCheckedOp: string,
): Promise<void> {
  const state: RebaseState = { version: 1, lastCheckedOp };
  await Bun.write(
    rebaseStatePath(gitDir),
    JSON.stringify(state, null, 2) + "\n",
  );
}
