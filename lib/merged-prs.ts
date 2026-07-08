import { execToSchema } from "./exec";
import { commitIdsIn } from "./jj";
import { CommitPullsSchema } from "./schema";

export interface MergedAncestorPr {
  prNumber: number;
  headRefOid: string;
  headRefName: string;
  mergedAt: string;
}

export interface MergedAncestorDetection {
  // Every merged PR found in the stack's ancestry, newest merge first.
  merged: MergedAncestorPr[];
  // The tipmost merged head per stranded stack; each one is the source of a
  // `jj rebase -s '<oid>+ & mutable()' -d 'trunk()'`.
  rebaseSources: MergedAncestorPr[];
}

export function emptyDetection(): MergedAncestorDetection {
  return { merged: [], rebaseSources: [] };
}

function errorText(error: unknown): string {
  if (error && typeof error === "object") {
    const { stderr, message } = error as { stderr?: string; message?: string };
    return `${stderr ?? ""}${message ?? ""}`;
  }
  return String(error);
}

// A stack is stranded when its base commit was the head of a PR that has
// since merged: squash- and rebase-merges rewrite the content into new trunk
// commits, so jj cannot see that the base landed. GitHub can: the
// commit->pulls endpoint names the PR a pushed commit belonged to, keyed by
// the exact commit we already hold locally -- no lookback window, no merge
// message conventions, and it works whether or not the head branch was
// deleted. Detection probes the stack roots and walks upward so stacked
// merged PRs (A and B merged, C still live) all surface.
export async function detectMergedAncestors(
  revset: string,
  nameWithOwner: string,
): Promise<MergedAncestorDetection> {
  const region = `trunk()..(${revset})`;
  const merged = new Map<number, MergedAncestorPr>();
  const probes = await commitIdsIn(`roots(${region})`);
  const probed = new Set<string>();
  let warned = false;

  while (probes.length > 0) {
    const probe = probes.shift()!;
    if (probed.has(probe)) continue;
    probed.add(probe);

    let pulls;
    try {
      pulls = await execToSchema(
        CommitPullsSchema,
        `gh api repos/${nameWithOwner}/commits/${probe}/pulls`,
      );
    } catch (error) {
      // 404/422 means the commit was never pushed (a brand-new stack) --
      // expected and silent. Anything else (offline, auth) degrades to "no
      // rebase" with a single warning.
      const text = errorText(error);
      if (!/HTTP 40[24]|HTTP 422/.test(text) && !warned) {
        warned = true;
        console.error(
          `merged-PR detection skipped: ${text.trim().split("\n")[0]}`,
        );
      }
      continue;
    }

    const candidates = pulls.filter(
      (pull) => pull.merged_at !== null && !merged.has(pull.number),
    );
    if (candidates.length === 0) continue;

    // A merged head only strands descendants if it still exists locally
    // outside trunk's ancestry (a true merge commit keeps the ancestry link,
    // so nothing needs rebasing).
    const present = new Set(
      await commitIdsIn(
        `(${candidates
          .map((pull) => `present(${pull.head.sha})`)
          .join(" | ")}) & ~::trunk()`,
      ),
    );
    for (const pull of candidates) {
      if (!present.has(pull.head.sha)) continue;
      merged.set(pull.number, {
        prNumber: pull.number,
        headRefOid: pull.head.sha,
        headRefName: pull.head.ref,
        mergedAt: pull.merged_at!,
      });
      // Another merged PR may sit directly above this one; probe upward.
      probes.push(
        ...(await commitIdsIn(`roots((${pull.head.sha}+) & ${region})`)),
      );
    }
  }

  const all = [...merged.values()].sort((a, b) =>
    b.mergedAt.localeCompare(a.mergedAt),
  );
  if (all.length === 0) return emptyDetection();

  const tipmost = new Set(
    await commitIdsIn(
      `heads(${all.map((m) => `present(${m.headRefOid})`).join(" | ")})`,
    ),
  );
  return {
    merged: all,
    rebaseSources: all.filter((m) => tipmost.has(m.headRefOid)),
  };
}
