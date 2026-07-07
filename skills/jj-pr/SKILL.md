---
name: jj-pr
description: Create and update stacked GitHub PRs from jj (Jujutsu) commits with jj-pr. Use whenever asked to open, stack, insert, or update pull requests in a jj repo — instead of hand-rolling `jj git push` + `gh pr create`.
---

# jj-pr

In jj repos, use `jj pr` (an alias for `jj-pr`) to turn commits into GitHub PRs. It handles the whole flow: bookmark creation, pushing, PR creation, pointing each PR in a stack at the one below it, and maintaining a "PR Stack" section in each PR body. Do not hand-roll this with `jj git push` and `gh pr create`.

## Usage

```sh
jj pr                     # PR for the nearest pushable change to @
jj pr <revset>            # PR(s) for a revset; a range creates one PR per change
jj pr 'trunk()..@'        # a PR for every change from trunk to the current change
jj pr --dry-run <revset>  # preview what would happen without pushing anything
```

What it does: finds the nearest pushable change to the revset (skipping unpushable ones, e.g. empty or missing a description), creates a bookmark there if none exists, pushes, creates any missing PRs, re-points stacked PRs at each other, and updates PR descriptions with stack links. Running it on a change in the middle of an existing stack inserts a new PR there and re-points its neighbors.

## Notes for agents

- Run `jj pr --dry-run <revset>` first and check the plan before pushing anything.
- The real run pauses at interactive confirmations ("push these bookmarks? (⏎ / n)"). With stdin closed (a non-interactive shell), it exits at the prompt **without pushing**. To confirm non-interactively, pipe empty lines so every prompt gets an Enter: `yes '' | jj pr <revset>`.
- To control a PR's branch name, create the bookmark on the change yourself before running `jj pr`; existing bookmarks are reused. Otherwise names are generated from the `jj-pr.bookmark-prefix` jj config.
- Requires an authenticated `gh` CLI. Changes need descriptions before they are considered pushable.
