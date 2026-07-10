// Structured view of `jj git push --dry-run` output. The raw text is still
// what gets rendered to the user (jj's wording/coloring is better than
// anything we'd reconstruct), but callers that need to reason about
// individual ref updates -- e.g. a future `jj-pr.allow` config that only
// prompts for confirmation on certain move kinds -- need each line parsed.

interface PushMoveBase {
  bookmark: string;
  raw: string; // original line, so an "unknown" kind stays inspectable
}

// Discriminated on `kind` so each variant carries exactly the fields jj
// reports for it: no optional from/to that only sometimes exist.
export type PushMove = PushMoveBase &
  (
    | { kind: "new"; to: string } // jj says "add to <sha>"
    | { kind: "forward" | "sideways" | "backward"; from: string; to: string }
    | { kind: "delete"; from: string }
    | { kind: "unknown" }
  );

export type PushMoveKind = PushMove["kind"];

// jj's own wording, captured from a real dry run (jj 0.41):
//   bookmark: foo [add to 7059ff5e606e]
//   bookmark: foo [move forward from 7059ff5e606e to f0d06d4a6bea]
//   bookmark: foo [move sideways from 7059ff5e606e to 8eda643fe5f7]
//   bookmark: foo [move backward from 8eda643fe5f7 to b78c7fbedec5]
//   bookmark: foo [delete from 8eda643fe5f7]
const BOOKMARK_LINE = /^\s*bookmark:\s*(\S+)\s*\[(.+)\]\s*$/;
const ADD = /^add to (\S+)$/;
const MOVE = /^move (forward|sideways|backward) from (\S+) to (\S+)$/;
const DELETE = /^delete from (\S+)$/;

// Parses each indented `bookmark: <name> [<verb> ...]` line into a PushMove.
// Never throws: jj's wording varies across versions, and a future consumer
// treats "unknown" as "always require confirmation" -- so an unrecognized
// verb must still surface as a move (lossless), just with kind "unknown",
// rather than being silently dropped (lossy). Header/footer lines (e.g.
// "Changes to push to origin:", "Dry-run requested, not pushing.") aren't
// bookmark lines and produce no moves.
export function parsePushPreview(output: string): PushMove[] {
  const moves: PushMove[] = [];
  for (const line of output.split("\n")) {
    const match = line.match(BOOKMARK_LINE);
    if (!match) continue;
    const [, bookmark, verb] = match;
    moves.push(parseVerb(bookmark!, verb!, line));
  }
  return moves;
}

function parseVerb(bookmark: string, verb: string, raw: string): PushMove {
  const add = verb.match(ADD);
  if (add) return { bookmark, kind: "new", to: add[1]!, raw };

  const move = verb.match(MOVE);
  if (move) {
    const kind = move[1] as "forward" | "sideways" | "backward";
    return { bookmark, kind, from: move[2]!, to: move[3]!, raw };
  }

  const del = verb.match(DELETE);
  if (del) return { bookmark, kind: "delete", from: del[1]!, raw };

  return { bookmark, kind: "unknown", raw };
}
