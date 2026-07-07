#!/usr/bin/env bun
import { mkdirSync, readFileSync, rmdirSync } from "node:fs";

interface FakePullRequest {
  number: number;
  head: string;
  title: string;
  baseRefName: string;
  body: string;
}

interface FakeGhState {
  nextNumber: number;
  prs: FakePullRequest[];
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

if (args[0] === "repo" && args[1] === "view") {
  console.log(JSON.stringify({ nameWithOwner: "example/repo" }));
  process.exit(0);
}

if (args[0] === "pr" && args[1] === "list") {
  const head = getOption(args, "--head");
  console.log(
    JSON.stringify(state.prs.filter((pr) => pr.head === head).map(prJson)),
  );
  process.exit(0);
}

if (args[0] === "pr" && args[1] === "create") {
  const head = getOption(args, "--head");
  const baseRefName = getOption(args, "--base");
  const number = state.nextNumber++;
  state.prs.push({ number, head, title: head, baseRefName, body: "" });
  await save();
  console.log(`https://github.com/example/repo/pull/${number}`);
  process.exit(0);
}

if (args[0] === "pr" && args[1] === "view") {
  const number = Number(args[2]);
  const pr = state.prs.find((item) => item.number === number);
  if (!pr) throw new Error(`No fake PR #${number}`);
  console.log(JSON.stringify(prJson(pr)));
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
