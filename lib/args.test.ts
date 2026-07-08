import { describe, expect, test } from "bun:test";
import { help, parseCli } from "./args";

describe("parseCli", () => {
  test("returns defaults with no args", () => {
    expect(parseCli([])).toEqual({
      revision: "closest_pushable(@)",
      dryRun: false,
      help: false,
      version: false,
    });
  });

  test("accepts a positional revset", () => {
    expect(parseCli(["abc"])).toEqual({
      revision: "abc",
      dryRun: false,
      help: false,
      version: false,
    });
  });

  test("accepts --revision flag", () => {
    expect(parseCli(["--revision", "foo"])).toEqual({
      revision: "foo",
      dryRun: false,
      help: false,
      version: false,
    });
  });
  test("accepts -r flag", () => {
    expect(parseCli(["-r", "foo"])).toEqual({
      revision: "foo",
      dryRun: false,
      help: false,
      version: false,
    });
  });

  test("rejects both positional revset and --revision flag", () => {
    expect(() => parseCli(["abc", "--revision", "foo"])).toThrowError(
      "Cannot specify both revset positional and --revision flag",
    );
    expect(() => parseCli(["--revision", "foo", "abc"])).toThrowError(
      "Cannot specify both revset positional and --revision flag",
    );
    expect(() => parseCli(["abc", "-r", "foo"])).toThrowError(
      "Cannot specify both revset positional and --revision flag",
    );
  });

  test("parses --dry-run", () => {
    expect(parseCli(["--dry-run"]).dryRun).toBe(true);
  });

  test("parses --help", () => {
    expect(parseCli(["--help"]).help).toBe(true);
  });

  test("parses -h", () => {
    expect(parseCli(["-h"]).help).toBe(true);
  });

  test("parses --version", () => {
    expect(parseCli(["--version"]).version).toBe(true);
  });

  test("parses -v", () => {
    expect(parseCli(["-v"]).version).toBe(true);
  });

  test("help matches snapshot", () => {
    expect(help()).toMatchSnapshot();
  });

  test("throws on unknown options", () => {
    expect(() => parseCli(["--unknown"])).toThrow(/Unknown option '--unknown'/);
  });

  test("throws when value-taking options are missing values", () => {
    expect(() => parseCli(["--revision"])).toThrow(
      /Option '-r, --revision <value>' argument missing/,
    );
  });
});
