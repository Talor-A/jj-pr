import { exec, execToSchema, execWithStdin, shellQuote } from "./exec";
import { jjCommand } from "./jj";
import {
  JJLogItemJsonSchema,
  PrStateSchema,
  PullRequestListSchema,
  PullRequestSchema,
  type PullRequest,
} from "./schema";
import type { PRPlan } from "./pr-stack";
import type { Ora } from "ora";

const prsByHead = new Map<string, PullRequest>();
const prsByNumber = new Map<number, PullRequest>();

export function cachePr(pr: PullRequest, head?: string): PullRequest {
  if (head) {
    prsByHead.set(head, pr);
  }
  prsByNumber.set(pr.number, pr);
  return pr;
}

export async function prForHead(
  head: string,
): Promise<PullRequest | undefined> {
  if (prsByHead.has(head)) {
    return prsByHead.get(head);
  }

  const existingPrs = await execToSchema(
    PullRequestListSchema,
    `gh pr list --head ${head} --json number,title,baseRefName,body`,
  );

  if (existingPrs[0]) {
    cachePr(existingPrs[0], head);
  }

  return existingPrs[0];
}

export async function prForNumber(number: number): Promise<PullRequest> {
  const cached = prsByNumber.get(number);
  if (cached) {
    return cached;
  }

  return cachePr(
    await execToSchema(
      PullRequestSchema,
      `gh pr view ${String(number)} --json number,title,baseRefName,body`,
    ),
  );
}

// `gh pr create --fill` derives the title/body from local git commits, which
// don't exist in a non-colocated workspace (jj only auto-exports bookmarks to
// git refs in colocated checkouts). Build them from the jj description instead.
async function prTitleAndBody(
  change: string,
  fallbackTitle: string,
): Promise<{ title: string; body: string }> {
  const item = await execToSchema(
    JJLogItemJsonSchema,
    jjCommand(`log -r ${shellQuote(change)} --no-graph -T 'json(self)'`),
  );
  const [summary = "", ...rest] = item.description.split(/\r?\n/);
  return {
    title: summary.trim() || fallbackTitle,
    body: unwrapHardWrappedText(rest.join("\n")),
  };
}

// Lines that start a new markdown block rather than continuing a wrapped
// prose line: list items, headings, blockquotes, code fences.
const MARKDOWN_BLOCK_START = /^\s*([-*+]\s|\d+[.)]\s|#{1,6}\s|>|```|~~~)/;
const CODE_FENCE = /^\s*(```|~~~)/;

// jj/git commit messages are conventionally hard-wrapped at ~80 chars. Join
// wrapped lines back into paragraphs so the PR body renders as intended
// markdown. Blank lines stay as paragraph breaks, lines that look like list
// items/headings/etc. start a new line instead of being joined into the
// previous one, and fenced code blocks are passed through verbatim.
export function unwrapHardWrappedText(text: string): string {
  const lines = text.trim().split(/\r?\n/);
  const out: string[] = [];
  let inCodeFence = false;
  if (lines.some((line) => line.length > 80)) return text;

  for (const line of lines) {
    if (inCodeFence) {
      out.push(line);
      if (CODE_FENCE.test(line)) inCodeFence = false;
      continue;
    }
    if (CODE_FENCE.test(line)) {
      inCodeFence = true;
      out.push(line);
      continue;
    }
    const trimmed = line.trim();
    const prev = out.at(-1);
    if (
      trimmed !== "" &&
      prev !== undefined &&
      prev !== "" &&
      !MARKDOWN_BLOCK_START.test(line)
    ) {
      out[out.length - 1] = `${prev} ${trimmed}`;
    } else {
      out.push(trimmed);
    }
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n");
}

export async function alignPRs(spinner: Ora, plans: PRPlan[]) {
  const prsByChange = new Map<string, { number: number; body: string }>();

  for (const plan of plans) {
    if (plan.action === "noop") {
      prsByChange.set(plan.change, {
        number: plan.existingPr.number,
        body: plan.existingPr.body ?? "",
      });
      continue;
    }

    const { action, headBookmark, baseBranch, existingPr, change } = plan;

    if (action === "update") {
      spinner.text = `updating base branch for ${headBookmark}...`;
      await exec(`gh pr edit ${existingPr.number} --base ${baseBranch}`);

      prsByChange.set(change, {
        number: existingPr.number,
        body: existingPr.body ?? "",
      });

      continue;
    }

    if (action === "create") {
      spinner.text = `creating new PR for ${headBookmark}...`;
      const { title, body } = await prTitleAndBody(change, headBookmark);
      await execWithStdin(
        `gh pr create --head ${headBookmark} --base ${baseBranch} --draft --title ${shellQuote(title)} --body-file -`,
        body,
      );

      const createdPrs = await execToSchema(
        PullRequestListSchema,
        `gh pr list --head ${headBookmark} --json number,title,baseRefName,body`,
      );
      if (!createdPrs[0]) {
        throw new Error(`Unable to find PR created for ${headBookmark}`);
      }

      const createdPr = cachePr(createdPrs[0], headBookmark);
      prsByChange.set(change, {
        number: createdPr.number,
        body: createdPr.body ?? "",
      });
    }
  }
  return prsByChange;
}

// GraphQL state enum: OPEN | CLOSED | MERGED. undefined when gh errors
// (e.g. the PR number no longer exists).
export function prState(
  number: number,
): Promise<{ number: number; state: string } | undefined> {
  return execToSchema(
    PrStateSchema,
    `gh pr view ${String(number)} --json number,state`,
  ).catch(() => undefined);
}
