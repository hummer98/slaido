import { describe, expect, it } from "bun:test";

import {
  ChromiumNotFoundError,
  CommandNotFoundError,
  DialogCanceledError,
  MkdtempFailedError,
  OutputIsDirectoryError,
  PdfPrintError,
  ZipFailedError,
  toExportError,
} from "./errors";

describe("toExportError", () => {
  it("ChromiumNotFoundError → category=chromium_not_found, phase=error", () => {
    const out = toExportError(new ChromiumNotFoundError());
    expect(out.category).toBe("chromium_not_found");
    expect(out.phase).toBe("error");
    expect(out.message.length).toBeGreaterThan(0);
    expect(out.silent).toBeFalsy();
  });

  it("DialogCanceledError → category=dialog_canceled, phase=canceled, silent", () => {
    const out = toExportError(new DialogCanceledError());
    expect(out.category).toBe("dialog_canceled");
    expect(out.phase).toBe("canceled");
    expect(out.silent).toBe(true);
  });

  it("PdfPrintError → category=print_failed, phase=error", () => {
    const out = toExportError(new PdfPrintError("boom", 7));
    expect(out.category).toBe("print_failed");
    expect(out.phase).toBe("error");
    expect(out.message).toContain("boom");
  });

  it("ZipFailedError → category=zip_failed, phase=error", () => {
    const out = toExportError(new ZipFailedError("oops", 3));
    expect(out.category).toBe("zip_failed");
    expect(out.phase).toBe("error");
  });

  it("MkdtempFailedError → category=mkdtemp_failed", () => {
    const out = toExportError(new MkdtempFailedError("nope"));
    expect(out.category).toBe("mkdtemp_failed");
    expect(out.phase).toBe("error");
  });

  it("OutputIsDirectoryError → category=output_is_directory", () => {
    const out = toExportError(new OutputIsDirectoryError("/tmp/somewhere"));
    expect(out.category).toBe("output_is_directory");
    expect(out.phase).toBe("error");
  });

  it("CommandNotFoundError → category=command_not_found", () => {
    const out = toExportError(new CommandNotFoundError("/usr/bin/zip"));
    expect(out.category).toBe("command_not_found");
    expect(out.phase).toBe("error");
  });

  it("AbortError-like (name=AbortError) → category=aborted, phase=canceled, silent", () => {
    const err = new Error("Aborted");
    err.name = "AbortError";
    const out = toExportError(err);
    expect(out.category).toBe("aborted");
    expect(out.phase).toBe("canceled");
    expect(out.silent).toBe(true);
  });

  it("ENOSPC → category=disk_full", () => {
    const err = Object.assign(new Error("no space"), { code: "ENOSPC" });
    const out = toExportError(err);
    expect(out.category).toBe("disk_full");
    expect(out.phase).toBe("error");
  });

  it("EACCES → category=permission_denied", () => {
    const err = Object.assign(new Error("denied"), { code: "EACCES" });
    const out = toExportError(err);
    expect(out.category).toBe("permission_denied");
    expect(out.phase).toBe("error");
  });

  it("EISDIR → category=output_is_directory", () => {
    const err = Object.assign(new Error("is a dir"), { code: "EISDIR" });
    const out = toExportError(err);
    expect(out.category).toBe("output_is_directory");
    expect(out.phase).toBe("error");
  });

  it("unknown error → category=print_failed (defensive: error)", () => {
    const out = toExportError(new Error("???"));
    expect(out.phase).toBe("error");
    expect(out.message.length).toBeGreaterThan(0);
  });
});
