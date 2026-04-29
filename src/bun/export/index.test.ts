import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  handleExportPdf,
  handleExportHtmlZip,
  type ExportProgressMessage,
  type ExportOrchestratorDeps,
} from "./index";

const FIXTURE_REVEAL_MINI = join(
  import.meta.dir,
  "..",
  "..",
  "..",
  "tests",
  "fixtures",
  "reveal-mini",
);

describe("handleExportPdf", () => {
  let cleanupDirs: string[] = [];
  afterEach(async () => {
    for (const dir of cleanupDirs) {
      await rm(dir, { recursive: true, force: true });
    }
    cleanupDirs = [];
  });

  it("emits start → done with phase + kind on success", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "slaido-out-"));
    cleanupDirs.push(outDir);
    const outputPath = join(outDir, "deck.pdf");

    const messages: ExportProgressMessage[] = [];
    const deps: ExportOrchestratorDeps = {
      send: (m) => messages.push(m),
      showSaveDialog: async () => outputPath,
      runPdf: async (args) => {
        await writeFile(args.outputPath, "%PDF-1.4\n", "binary");
      },
    };

    await handleExportPdf(
      {
        title: "deck",
        slidesEntry: join(FIXTURE_REVEAL_MINI, "slides", "index.html"),
        templateRoot: FIXTURE_REVEAL_MINI,
      },
      deps,
    );

    expect(messages.length).toBeGreaterThanOrEqual(2);
    expect(messages[0]).toEqual({ type: "export-progress", kind: "pdf", phase: "start" });
    const last = messages[messages.length - 1];
    expect(last?.kind).toBe("pdf");
    expect(last?.phase).toBe("done");
  });

  it("emits start → canceled (silent) when save-dialog returns null", async () => {
    const messages: ExportProgressMessage[] = [];
    let pdfRan = 0;
    const deps: ExportOrchestratorDeps = {
      send: (m) => messages.push(m),
      showSaveDialog: async () => null,
      runPdf: async () => {
        pdfRan += 1;
      },
    };

    await handleExportPdf(
      {
        title: "deck",
        slidesEntry: join(FIXTURE_REVEAL_MINI, "slides", "index.html"),
        templateRoot: FIXTURE_REVEAL_MINI,
      },
      deps,
    );

    expect(pdfRan).toBe(0);
    expect(messages.map((m) => m.phase)).toEqual(["start", "canceled"]);
    const last = messages[messages.length - 1];
    expect(last?.phase).toBe("canceled");
    expect(last?.silent).toBe(true);
  });

  it("emits start → error with category when pdf throws", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "slaido-out-"));
    cleanupDirs.push(outDir);

    const messages: ExportProgressMessage[] = [];
    const deps: ExportOrchestratorDeps = {
      send: (m) => messages.push(m),
      showSaveDialog: async () => join(outDir, "deck.pdf"),
      runPdf: async () => {
        // import lazily to avoid circular type re-export
        const { PdfPrintError } = await import("./errors");
        throw new PdfPrintError("Chromium boom", 9);
      },
    };

    await handleExportPdf(
      {
        title: "deck",
        slidesEntry: join(FIXTURE_REVEAL_MINI, "slides", "index.html"),
        templateRoot: FIXTURE_REVEAL_MINI,
      },
      deps,
    );

    const last = messages[messages.length - 1];
    expect(last?.phase).toBe("error");
    expect(last?.kind).toBe("pdf");
    expect(last?.category).toBe("print_failed");
    expect(last?.message).toContain("Chromium boom");
  });
});

describe("handleExportHtmlZip", () => {
  let cleanupDirs: string[] = [];
  afterEach(async () => {
    for (const dir of cleanupDirs) {
      await rm(dir, { recursive: true, force: true });
    }
    cleanupDirs = [];
  });

  it("emits start → canceled when save-dialog returns null", async () => {
    const messages: ExportProgressMessage[] = [];
    let zipRan = 0;
    const deps: ExportOrchestratorDeps = {
      send: (m) => messages.push(m),
      showSaveDialog: async () => null,
      runHtmlZip: async () => {
        zipRan += 1;
      },
    };

    await handleExportHtmlZip(
      {
        title: "deck",
        slidesDir: join(FIXTURE_REVEAL_MINI, "slides"),
        templateRoot: FIXTURE_REVEAL_MINI,
      },
      deps,
    );

    expect(zipRan).toBe(0);
    expect(messages[0]).toEqual({
      type: "export-progress",
      kind: "html-zip",
      phase: "start",
    });
    const last = messages[messages.length - 1];
    expect(last?.phase).toBe("canceled");
    expect(last?.silent).toBe(true);
  });

  it("emits start → done on success", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "slaido-out-"));
    cleanupDirs.push(outDir);
    const outputPath = join(outDir, "deck.zip");

    const messages: ExportProgressMessage[] = [];
    let captured: { outputPath: string } | null = null as { outputPath: string } | null;
    const deps: ExportOrchestratorDeps = {
      send: (m) => messages.push(m),
      showSaveDialog: async () => outputPath,
      runHtmlZip: async (args) => {
        captured = { outputPath: args.outputPath };
        await writeFile(args.outputPath, "PK", "binary");
      },
    };

    await handleExportHtmlZip(
      {
        title: "deck",
        slidesDir: join(FIXTURE_REVEAL_MINI, "slides"),
        templateRoot: FIXTURE_REVEAL_MINI,
      },
      deps,
    );

    expect(captured?.outputPath).toBe(outputPath);
    const last = messages[messages.length - 1];
    expect(last?.phase).toBe("done");
    expect(last?.kind).toBe("html-zip");
  });
});
