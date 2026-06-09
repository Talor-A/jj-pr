import { z } from "zod";

const parseJsonPreprocessor = (value: unknown, ctx: z.RefinementCtx) => {
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch (e) {
      ctx.addIssue({
        code: "custom",
        message: (e as Error).message,
      });
    }
  }

  return value;
};

export const PullRequestSchema = z.preprocess(
  parseJsonPreprocessor,
  z.object({
    number: z.number(),
    title: z.string(),
    baseRefName: z.string(),
    body: z.string().nullable(),
  }),
);
export const PullRequestListSchema = z.preprocess(
  parseJsonPreprocessor,
  z.array(PullRequestSchema),
);
export const RepoSchema = z.preprocess(
  parseJsonPreprocessor,
  z.object({ nameWithOwner: z.string() }),
);
export const JJLogItemJsonSchema = z.preprocess(
  parseJsonPreprocessor,
  z.object({
    commit_id: z.string(),
    parents: z.array(z.string()),
    change_id: z.string(),
    description: z.string(),
    author: z.object({
      name: z.string(),
      email: z.string(),
      timestamp: z.string(),
    }),
    committer: z.object({
      name: z.string(),
      email: z.string(),
      timestamp: z.string(),
    }),
  }),
);

export type PullRequest = z.infer<typeof PullRequestSchema>;
