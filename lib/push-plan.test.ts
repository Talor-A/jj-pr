import { describe, expect, test } from "bun:test";
import { parsePushPreview, type PushMove } from "./push-plan";

// Fixture captured from a real `jj git push --dry-run` (jj 0.41).
const MULTI_BOOKMARK_PREVIEW = `Changes to push to origin:
  bookmark: foo [add to 7059ff5e606e]
  bookmark: foo [move forward from 7059ff5e606e to f0d06d4a6bea]
  bookmark: foo [move sideways from 7059ff5e606e to 8eda643fe5f7]
  bookmark: foo [move backward from 8eda643fe5f7 to b78c7fbedec5]
  bookmark: foo [delete from 8eda643fe5f7]
Dry-run requested, not pushing.`;

describe("parsePushPreview", () => {
  test("add to <sha> parses as kind new", () => {
    const moves = parsePushPreview(
      "Changes to push to origin:\n  bookmark: foo [add to 7059ff5e606e]\nDry-run requested, not pushing.",
    );
    expect(moves).toEqual([
      {
        bookmark: "foo",
        kind: "new",
        to: "7059ff5e606e",
        raw: "  bookmark: foo [add to 7059ff5e606e]",
      },
    ] satisfies PushMove[]);
  });

  test("move forward parses from/to", () => {
    const moves = parsePushPreview(
      "  bookmark: foo [move forward from 7059ff5e606e to f0d06d4a6bea]",
    );
    expect(moves).toEqual([
      {
        bookmark: "foo",
        kind: "forward",
        from: "7059ff5e606e",
        to: "f0d06d4a6bea",
        raw: "  bookmark: foo [move forward from 7059ff5e606e to f0d06d4a6bea]",
      },
    ] satisfies PushMove[]);
  });

  test("move sideways parses from/to", () => {
    const moves = parsePushPreview(
      "  bookmark: foo [move sideways from 7059ff5e606e to 8eda643fe5f7]",
    );
    expect(moves).toEqual([
      {
        bookmark: "foo",
        kind: "sideways",
        from: "7059ff5e606e",
        to: "8eda643fe5f7",
        raw: "  bookmark: foo [move sideways from 7059ff5e606e to 8eda643fe5f7]",
      },
    ] satisfies PushMove[]);
  });

  test("move backward parses from/to", () => {
    const moves = parsePushPreview(
      "  bookmark: foo [move backward from 8eda643fe5f7 to b78c7fbedec5]",
    );
    expect(moves).toEqual([
      {
        bookmark: "foo",
        kind: "backward",
        from: "8eda643fe5f7",
        to: "b78c7fbedec5",
        raw: "  bookmark: foo [move backward from 8eda643fe5f7 to b78c7fbedec5]",
      },
    ] satisfies PushMove[]);
  });

  test("delete from <sha> parses as kind delete with only from", () => {
    const moves = parsePushPreview(
      "  bookmark: foo [delete from 8eda643fe5f7]",
    );
    expect(moves).toEqual([
      {
        bookmark: "foo",
        kind: "delete",
        from: "8eda643fe5f7",
        raw: "  bookmark: foo [delete from 8eda643fe5f7]",
      },
    ] satisfies PushMove[]);
  });

  test("multi-bookmark preview: one move per line, header/footer ignored", () => {
    const moves = parsePushPreview(MULTI_BOOKMARK_PREVIEW);
    expect(moves.map((m) => m.kind)).toEqual([
      "new",
      "forward",
      "sideways",
      "backward",
      "delete",
    ]);
    expect(moves.every((m) => m.bookmark === "foo")).toBe(true);
  });

  test("unrecognized verb becomes kind unknown but stays inspectable via raw", () => {
    const line = "  bookmark: foo [renamed from bar]";
    const moves = parsePushPreview(line);
    expect(moves).toEqual([
      { bookmark: "foo", kind: "unknown", raw: line },
    ] satisfies PushMove[]);
  });

  test("'Nothing changed.' output has no bookmark lines, so no moves", () => {
    expect(parsePushPreview("Nothing changed.")).toEqual([]);
  });

  test("empty string yields no moves", () => {
    expect(parsePushPreview("")).toEqual([]);
  });

  test("header-only output (no bookmark lines) yields no moves", () => {
    expect(
      parsePushPreview(
        "Changes to push to origin:\nDry-run requested, not pushing.",
      ),
    ).toEqual([]);
  });
});
