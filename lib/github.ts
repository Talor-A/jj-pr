import { execToSchema } from "./exec";
import {
  PullRequestListSchema,
  PullRequestSchema,
  type PullRequest,
} from "./schema";

const prsByHead = new Map<string, PullRequest>();
const prsByNumber = new Map<number, PullRequest>();

export function cachePr(pr: PullRequest, head?: string): PullRequest {
  if (head) {
    prsByHead.set(head, pr);
  }
  prsByNumber.set(pr.number, pr);
  return pr;
}

export async function prForHead(head: string): Promise<PullRequest | undefined> {
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
