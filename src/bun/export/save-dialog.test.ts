import { describe, expect, it } from "bun:test";

import {
  buildOsascriptSource,
  parseOsascriptResult,
  sanitizeDefaultName,
  ensureExtension,
} from "./save-dialog";

describe("parseOsascriptResult", () => {
  it("returns the trimmed NFC-normalized path on success", () => {
    const stdout = "/Users/me/Documents/foo.pdf\n";
    const result = parseOsascriptResult(stdout, 0, "");
    expect(result).toBe("/Users/me/Documents/foo.pdf");
  });

  it("normalizes NFD path to NFC", () => {
    // "ä" = U+00E4 (NFC) vs "a" + U+0308 (NFD)
    const nfd = "/Users/me/Documents/" + "a" + "̈" + ".pdf";
    const stdout = nfd + "\n";
    const result = parseOsascriptResult(stdout, 0, "");
    expect(result).toBe(nfd.normalize("NFC"));
    expect(result).toBe("/Users/me/Documents/ä.pdf");
  });

  it("returns null when user cancels (exit 1 + 'User canceled.' stderr)", () => {
    const result = parseOsascriptResult("", 1, "execution error: User canceled. (-128)\n");
    expect(result).toBeNull();
  });

  it("returns null on exit 1 with -128 error code in stderr", () => {
    const result = parseOsascriptResult("", 1, "0:0: execution error: ユーザによってキャンセルされました。 (-128)\n");
    expect(result).toBeNull();
  });

  it("throws on exit non-zero with non-cancel stderr", () => {
    expect(() =>
      parseOsascriptResult("", 1, "execution error: something else (-42)\n"),
    ).toThrow();
  });

  it("throws when exit 0 but stdout is empty", () => {
    expect(() => parseOsascriptResult("", 0, "")).toThrow();
  });
});

describe("sanitizeDefaultName", () => {
  it("replaces / and : with _", () => {
    expect(sanitizeDefaultName("a/b:c.pdf")).toBe("a_b_c.pdf");
  });

  it("falls back to 'presentation' for empty input", () => {
    expect(sanitizeDefaultName("")).toBe("presentation");
  });

  it("falls back to 'presentation' for whitespace-only", () => {
    expect(sanitizeDefaultName("   ")).toBe("presentation");
  });

  it("falls back to 'presentation' when all chars are illegal", () => {
    expect(sanitizeDefaultName("///:::")).toBe("presentation");
  });
});

describe("ensureExtension", () => {
  it("adds extension when missing", () => {
    expect(ensureExtension("/tmp/foo", "pdf")).toBe("/tmp/foo.pdf");
  });

  it("keeps the path unchanged when extension already matches (case-insensitive)", () => {
    expect(ensureExtension("/tmp/foo.pdf", "pdf")).toBe("/tmp/foo.pdf");
    expect(ensureExtension("/tmp/foo.PDF", "pdf")).toBe("/tmp/foo.PDF");
  });

  it("appends extension when path has a different extension", () => {
    expect(ensureExtension("/tmp/foo.txt", "pdf")).toBe("/tmp/foo.txt.pdf");
  });
});

describe("buildOsascriptSource", () => {
  it("includes the prompt, default name, and POSIX file location", () => {
    const src = buildOsascriptSource({
      prompt: "保存先を選択",
      defaultName: "foo.pdf",
      defaultDir: "/Users/me/Documents",
    });
    expect(src).toContain('with prompt "保存先を選択"');
    expect(src).toContain('default name "foo.pdf"');
    expect(src).toContain('POSIX file "/Users/me/Documents"');
    expect(src).toContain("POSIX path of theFile");
  });

  it("escapes embedded double quotes in defaultName", () => {
    const src = buildOsascriptSource({
      prompt: "save",
      defaultName: 'foo "bar".pdf',
      defaultDir: "/tmp",
    });
    expect(src).toContain('default name "foo \\"bar\\".pdf"');
  });
});
