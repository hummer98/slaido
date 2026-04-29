import { describe, expect, test } from "bun:test";

import { extractToolPath, TOOL_PATH_KEYS } from "./extract-tool-path";
import type { OpencodeToolState } from "../opencode/types";

function makeState(input: Record<string, unknown> | undefined): OpencodeToolState {
  return { status: "completed", input } as unknown as OpencodeToolState;
}

describe("extractToolPath", () => {
  test("returns input.filePath when present (highest priority)", () => {
    const state = makeState({
      filePath: "/abs/slides/index.html",
      file_path: "ignored",
      path: "ignored",
    });
    expect(extractToolPath(state)).toBe("/abs/slides/index.html");
  });

  test("falls back to file_path when filePath is missing", () => {
    const state = makeState({ file_path: "/abs/slides/index.html" });
    expect(extractToolPath(state)).toBe("/abs/slides/index.html");
  });

  test("falls back to file when file_path is missing", () => {
    const state = makeState({ file: "/abs/slides/index.html" });
    expect(extractToolPath(state)).toBe("/abs/slides/index.html");
  });

  test("falls back to path last (lowest priority)", () => {
    const state = makeState({ path: "/abs/slides/index.html" });
    expect(extractToolPath(state)).toBe("/abs/slides/index.html");
  });

  test("uses key priority order: filePath > file_path > file > path", () => {
    expect(TOOL_PATH_KEYS).toEqual(["filePath", "file_path", "file", "path"]);
  });

  test("returns null for empty object", () => {
    expect(extractToolPath(makeState({}))).toBeNull();
  });

  test("returns null when input is undefined", () => {
    expect(extractToolPath(makeState(undefined))).toBeNull();
  });

  test("returns null when state has no input field", () => {
    expect(extractToolPath({ status: "completed" } as unknown as OpencodeToolState)).toBeNull();
  });

  test("returns null when value is non-string", () => {
    expect(extractToolPath(makeState({ filePath: 42 }))).toBeNull();
    expect(extractToolPath(makeState({ filePath: null }))).toBeNull();
    expect(extractToolPath(makeState({ filePath: { nested: "x" } }))).toBeNull();
  });

  test("returns null when value is empty string", () => {
    expect(extractToolPath(makeState({ filePath: "" }))).toBeNull();
  });

  test("skips non-string filePath and falls back to next key", () => {
    const state = makeState({ filePath: 42, file_path: "/abs/slides/index.html" });
    expect(extractToolPath(state)).toBe("/abs/slides/index.html");
  });
});
