import { describe, expect, test } from "bun:test";
import {
  closestBookmarkBeforeChangeRevset,
  existingBookmarkResults,
  jjLogBookmarksCommand,
  mergeBookmarkResults,
  type BookmarkResult,
  type BookmarkResultWithHead,
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
      "/Users/ta/.dotfiles/projects/jj-ts/config.toml",
      closestBookmarkBeforeChangeRevset(change),
    );

    expect(cmd).toContain(
      "-r 'closest_bookmark(mykpnrqwkvyxuzqqntuulzxwsrvxlkxm-)'",
    );
    expect(cmd).not.toContain("-r closest_bookmark(");
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
