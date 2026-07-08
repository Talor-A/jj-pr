import { parseArgs as nodeParseArgs } from "node:util";
import { z } from "zod";

const CliSchema = z.object({
  revision: z.string().default("closest_pushable(@)"),
  dryRun: z.boolean().default(false),
  help: z.boolean().default(false),
  version: z.boolean().default(false),
});

export type CliArgs = z.infer<typeof CliSchema>;

export function help(): string {
  return `Usage: jj pr [options] [revset]

Sync jj bookmarks with GitHub PRs: fetch, rebase stacks, push bookmarks,
create or update PRs, and maintain PR stack descriptions.

Arguments:
  revset                Revision to process (default: closest_pushable(@))

Options:
  -r, --revision <rev>  Revision to process (alternative to positional)
      --dry-run         Preview changes without applying them
  -h, --help            Show this help message
  -v, --version         Show version number

Commands:
  completion <shell>    Print shell completion script (bash, zsh, or fish)
`;
}

export function parseCli(argv: string[]) {
  const { values, positionals } = nodeParseArgs({
    args: argv,
    options: {
      "dry-run": { type: "boolean" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
      revision: { type: "string", short: "r" },
    },
    allowPositionals: true,
  });
  if (positionals[0] && values.revision) {
    throw new Error(
      "Cannot specify both revset positional and --revision flag",
    );
  }
  return CliSchema.parse({
    revision: positionals[0] ?? values.revision,
    dryRun: values["dry-run"],
    help: values.help,
    version: values.version,
  });
}
