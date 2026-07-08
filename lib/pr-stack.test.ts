import { describe, expect, test } from "bun:test";
import {
  closestBookmarkBeforeChangeRevset,
  existingBookmarkResults,
  jjLogBookmarksCommand,
  mergeBookmarkResults,
  parsePrStackSection,
  proposedBookmarkRevset,
  renderStackMarkdown,
  type BookmarkResult,
  type BookmarkResultWithHead,
  type ResolvedBookmark,
} from "./pr-stack";

const pr = { number: 42, title: "t", baseRefName: "main", body: null };

describe("closestBookmarkRevset", () => {
  test("builds the revset used to find a change's base branch", () => {
    expect(
      closestBookmarkBeforeChangeRevset("mykpnrqwkvyxuzqqntuulzxwsrvxlkxm"),
    ).toBe("closest_bookmark(mykpnrqwkvyxuzqqntuulzxwsrvxlkxm-)");
  });
});

describe("jjLogBookmarksCommand", () => {
  test("regression: shell-quotes revsets with parentheses", () => {
    const change = "mykpnrqwkvyxuzqqntuulzxwsrvxlkxm";
    const cmd = jjLogBookmarksCommand(
      closestBookmarkBeforeChangeRevset(change),
      "/path/to/config.toml",
    );

    expect(cmd).toContain(
      "-r 'closest_bookmark(mykpnrqwkvyxuzqqntuulzxwsrvxlkxm-)'",
    );
    expect(cmd).not.toContain("-r closest_bookmark(");
  });
});

describe("proposedBookmarkRevset", () => {
  test("degenerates to bookmarks() when nothing is planned", () => {
    const input = [
      {
        kind: "pr",
        change: "qlruyyvy",
        headBookmark: "ta/jj/e2e-test",
        existingPr: pr,
      },
    ] satisfies ResolvedBookmark[];

    expect(proposedBookmarkRevset(input)).toBe("bookmarks()");
  });

  test("unions planned changes with bookmarks()", () => {
    const input = [
      {
        kind: "pr",
        change: "qlruyyvy",
        headBookmark: "ta/jj/e2e-test",
        existingPr: pr,
      },
      {
        kind: "planned",
        change: "mykpnrqw",
        headBookmark: "ta/jj/planned",
      },
      {
        kind: "planned",
        change: "yznrkqrt",
        headBookmark: "ta/jj/also-planned",
      },
    ] satisfies ResolvedBookmark[];

    expect(proposedBookmarkRevset(input)).toBe(
      "(bookmarks() | mykpnrqw | yznrkqrt)",
    );
  });
});

describe("existingBookmarkResults", () => {
  test("returns all changes that already have bookmarks", () => {
    const input = [
      { change: "qlruyyvy", headBookmark: "ta/jj/e2e-test", existingPr: pr },
      {
        change: "mykpnrqw",
        headBookmark: "ta/jj/pin-vector",
        existingPr: undefined,
      },
    ] satisfies BookmarkResultWithHead[];

    expect(existingBookmarkResults(input)).toEqual(input);
  });

  test("drops changes with no bookmark", () => {
    const input: BookmarkResult[] = [
      { change: "yznrkqrt", headBookmark: undefined, existingPr: undefined },
      { change: "qlruyyvy", headBookmark: "ta/jj/e2e-test", existingPr: pr },
    ];

    expect(existingBookmarkResults(input)).toEqual([
      { change: "qlruyyvy", headBookmark: "ta/jj/e2e-test", existingPr: pr },
    ]);
  });

  test("regression: empty new-bookmark list must not wipe existing bookmarked changes", () => {
    const bookmarkedStack: BookmarkResult[] = [
      { change: "qlruyyvy", headBookmark: "ta/jj/e2e-test", existingPr: pr },
      {
        change: "mykpnrqw",
        headBookmark: "ta/jj/pin-vector",
        existingPr: pr,
      },
    ];

    // approveAndPushNewBookmarks used to return [] in this case.
    expect(existingBookmarkResults(bookmarkedStack)).toHaveLength(2);
  });
});

describe("mergeBookmarkResults", () => {
  test("keeps existing bookmarked changes when new ones are pushed", () => {
    const existing = [
      { change: "qlruyyvy", headBookmark: "ta/jj/e2e-test", existingPr: pr },
      { change: "yznrkqrt", headBookmark: undefined, existingPr: undefined },
    ] satisfies BookmarkResult[];
    const newlyPrepared = [
      {
        change: "yznrkqrt",
        headBookmark: "ta/jj/empty-commit",
        existingPr: undefined,
        new: true,
      },
    ] satisfies BookmarkResultWithHead[];

    expect(mergeBookmarkResults(existing, newlyPrepared)).toEqual([
      { change: "qlruyyvy", headBookmark: "ta/jj/e2e-test", existingPr: pr },
      {
        change: "yznrkqrt",
        headBookmark: "ta/jj/empty-commit",
        existingPr: undefined,
        new: true,
      },
    ]);
  });
});

describe("renderStackMarkdown", () => {
  test("renders placeholders for entries without PR numbers, newest first", () => {
    expect(
      renderStackMarkdown(
        [
          { change: "qlruyyvy", headBookmark: "ta/jj/bottom", prNumber: 1 },
          { change: "mykpnrqw", headBookmark: "ta/jj/top" },
        ],
        "main",
        "example/repo",
      ),
    ).toBe(
      "## PR Stack\n" +
        "- [new PR] ta/jj/top\n" +
        "- https://github.com/example/repo/pull/1\n" +
        "- `main`\n",
    );
  });

  test("renders links for entries that all have PR numbers", () => {
    expect(
      renderStackMarkdown(
        [
          { change: "qlruyyvy", headBookmark: "ta/jj/bottom", prNumber: 1 },
          { change: "mykpnrqw", headBookmark: "ta/jj/top", prNumber: 2 },
        ],
        "main",
        "example/repo",
      ),
    ).toBe(
      "## PR Stack\n" +
        "- https://github.com/example/repo/pull/2\n" +
        "- https://github.com/example/repo/pull/1\n" +
        "- `main`\n",
    );
  });

  test("renders just the heading and trunk when there are no entries", () => {
    expect(renderStackMarkdown([], "main", "example/repo")).toBe(
      "## PR Stack\n- `main`\n",
    );
  });

  test("renders merged ancestors below the trunk line", () => {
    expect(
      renderStackMarkdown(
        [{ change: "qlruyyvy", headBookmark: "ta/jj/top", prNumber: 2 }],
        "main",
        "example/repo",
        [1, 7],
      ),
    ).toBe(
      "## PR Stack\n" +
        "- https://github.com/example/repo/pull/2\n" +
        "- `main`\n" +
        "- https://github.com/example/repo/pull/1\n" +
        "- https://github.com/example/repo/pull/7\n",
    );
  });
});

describe("parsePrStackSection", () => {
  test("returns undefined when the body has no section", () => {
    expect(parsePrStackSection("just a description")).toBeUndefined();
  });

  test("splits PR numbers at the trunk line", () => {
    const body =
      "description\n\n## PR Stack\n" +
      "- https://github.com/x/y/pull/3\n" +
      "- https://github.com/x/y/pull/2\n" +
      "- `main`\n" +
      "- https://github.com/x/y/pull/1\n";
    expect(parsePrStackSection(body)).toEqual({
      above: [3, 2],
      below: [1],
    });
  });

  test("ignores [new PR] placeholders and handles a missing tail", () => {
    const body =
      "## PR Stack\n- [new PR] ta/jj/top\n- https://github.com/x/y/pull/2\n- `main`\n";
    expect(parsePrStackSection(body)).toEqual({ above: [2], below: [] });
  });

  test("reads the last section when duplicates accumulated", () => {
    const body =
      "## PR Stack\n- https://github.com/x/y/pull/9\n- `main`\n\n" +
      "## PR Stack\n- https://github.com/x/y/pull/2\n- `main`\n- https://github.com/x/y/pull/1\n";
    expect(parsePrStackSection(body)).toEqual({ above: [2], below: [1] });
  });

  test("normalizes CRLF bodies as GitHub returns them", () => {
    const body =
      "desc\r\n\r\n## PR Stack\r\n- https://github.com/x/y/pull/2\r\n- `main`\r\n- https://github.com/x/y/pull/1\r\n";
    expect(parsePrStackSection(body)).toEqual({ above: [2], below: [1] });
  });

  test("round-trips what renderStackMarkdown produces", () => {
    const rendered = renderStackMarkdown(
      [{ change: "qlruyyvy", headBookmark: "ta/jj/top", prNumber: 2 }],
      "main",
      "example/repo",
      [1],
    );
    expect(parsePrStackSection(`body\n\n${rendered}`)).toEqual({
      above: [2],
      below: [1],
    });
  });
});
