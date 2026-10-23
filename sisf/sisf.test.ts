import { describe, expect, test } from "bun:test";
import { _test } from "./sisf";
const { safeId, parseRemote } = _test;

describe("safeId", () => {
  test("sanitizes for branch names", () => {
    expect(safeId("SISF-P1_Skeleton!")).toBe("sisf-p1-skeleton");
    expect(safeId("---")).toBe("task");
    expect(safeId("a".repeat(80))).toHaveLength(60);
  });
});

describe("parseRemote", () => {
  test("https / ssh / scp-style", () => {
    expect(parseRemote("https://git.example.com/o/r.git")).toEqual({ owner: "o", repo: "r" });
    expect(parseRemote("git@localhost:o/r.git")).toEqual({ owner: "o", repo: "r" });
    expect(parseRemote("ssh://git@h:22/o/r")).toEqual({ owner: "o", repo: "r" });
    expect(parseRemote("/local/path")).toBeNull();
  });
});
