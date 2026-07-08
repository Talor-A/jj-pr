#!/usr/bin/env bun
import { mkdirSync, readFileSync, rmdirSync } from "node:fs";

interface FakePullRequest {
  number: number;
  head: string;
  title: string;
  baseRefName: string;
  body: string;
  state?: "open" | "closed";
  mergedAt?: string | null;
  headSha?: string;
  mergeCommitSha?: string;
  commits?: string[]; // shas the PR's branch contained, for the api handler
}

interface FakeGhState {
  nextNumber: number;
  prs: FakePullRequest[];
  commands?: string[][];
  failApi?: boolean; // make `gh api` calls fail, to test degraded detection
}

function isOpen(pr: FakePullRequest): boolean {
  return (pr.state ?? "open") === "open";
}

// gh's GraphQL state enum, as `gh pr view --json state` reports it.
function graphqlState(pr: FakePullRequest): string {
  if (isOpen(pr)) return "OPEN";
  return pr.mergedAt ? "MERGED" : "CLOSED";
}

function getOption(args: string[], option: string): string {
  const value = args[args.indexOf(option) + 1];
  if (value === undefined) {
    throw new Error(`${option} is required`);
  }
  return value;
}

function prJson(pr: FakePullRequest) {
  return {
    number: pr.number,
    title: pr.title,
    baseRefName: pr.baseRefName,
    body: pr.body,
  };
}

const statePath = process.env.FAKE_GH_STATE;
if (!statePath) throw new Error("FAKE_GH_STATE is required");

// jj-pr runs gh commands concurrently; the whole-file read-modify-write of
// the state must be atomic or parallel edits clobber each other. mkdir is
// atomic, so hold a directory lock for the lifetime of the process.
const lockPath = `${statePath}.lock`;
while (true) {
  try {
    mkdirSync(lockPath);
    break;
  } catch {
    await Bun.sleep(2);
  }
}
process.on("exit", () => {
  try {
    rmdirSync(lockPath);
  } catch {}
});

const args = process.argv.slice(2);
const state = JSON.parse(await Bun.file(statePath).text()) as FakeGhState;
const save = async () => {
  await Bun.write(statePath, JSON.stringify(state));
};
// Record every invocation so tests can assert which gh commands ran (e.g.
// that a dry run never issued a mutating one).
state.commands ??= [];
state.commands.push(args);
await save();

if (args[0] === "repo" && args[1] === "view") {
  console.log(JSON.stringify({ nameWithOwner: "example/repo" }));
  process.exit(0);
}

if (args[0] === "pr" && args[1] === "list") {
  // Real `gh pr list` returns only open PRs unless --state says otherwise.
  const head = getOption(args, "--head");
  console.log(
    JSON.stringify(
      state.prs.filter((pr) => isOpen(pr) && pr.head === head).map(prJson),
    ),
  );
  process.exit(0);
}

// "List pull requests associated with a commit". Matches PRs whose recorded
// branch commits (or head sha) include the probed sha.
if (args[0] === "api") {
  const pulls = args[1]?.match(
    /^repos\/[^/]+\/[^/]+\/commits\/([^/]+)\/pulls$/,
  );
  if (pulls) {
    if (state.failApi) {
      console.error("gh: Internal Server Error (HTTP 500)");
      process.exit(1);
    }
    const sha = pulls[1];
    const matches = state.prs.filter(
      (pr) => pr.headSha === sha || pr.commits?.includes(sha ?? ""),
    );
    console.log(
      JSON.stringify(
        matches.map((pr) => ({
          number: pr.number,
          state: isOpen(pr) ? "open" : "closed",
          merged_at: pr.mergedAt ?? null,
          merge_commit_sha: pr.mergeCommitSha ?? null,
          head: { ref: pr.head, sha: pr.headSha ?? "" },
          base: { ref: pr.baseRefName },
        })),
      ),
    );
    process.exit(0);
  }
}

if (args[0] === "pr" && args[1] === "create") {
  const head = getOption(args, "--head");
  const baseRefName = getOption(args, "--base");
  const title = args.includes("--title") ? getOption(args, "--title") : head;
  const body = args.includes("--body-file") ? readFileSync(0, "utf8") : "";
  const number = state.nextNumber++;
  state.prs.push({ number, head, title, baseRefName, body });
  await save();
  console.log(`https://github.com/example/repo/pull/${number}`);
  process.exit(0);
}

if (args[0] === "pr" && args[1] === "view") {
  const number = Number(args[2]);
  const pr = state.prs.find((item) => item.number === number);
  if (!pr) throw new Error(`No fake PR #${number}`);
  // Extra fields are harmless: the schemas strip what they didn't ask for.
  console.log(JSON.stringify({ ...prJson(pr), state: graphqlState(pr) }));
  process.exit(0);
}

if (args[0] === "pr" && args[1] === "edit") {
  const number = Number(args[2]);
  const pr = state.prs.find((item) => item.number === number);
  if (!pr) throw new Error(`No fake PR #${number}`);
  if (args.includes("--base")) {
    pr.baseRefName = getOption(args, "--base");
  }
  if (args.includes("--body-file")) {
    pr.body = readFileSync(0, "utf8");
  }
  await save();
  process.exit(0);
}

console.error(`Unhandled fake gh command: ${args.join(" ")}`);
process.exit(1);
