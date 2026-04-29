import { afterEach, describe, expect, it } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { ChromiumNotFoundError, PdfPrintError } from "./errors";
import { buildChromiumArgs, exportPdf } from "./pdf";

const SLIDES_FIXTURE = join(
  import.meta.dir,
  "..",
  "..",
  "..",
  "tests",
  "fixtures",
  "reveal-mini",
  "slides",
  "index.html",
);

describe("buildChromiumArgs", () => {
  it("includes --headless / --print-to-pdf / --user-data-dir / file URL with ?print-pdf", () => {
    const args = buildChromiumArgs(
      "/abs/slides/index.html",
      "/abs/out.pdf",
      "/tmp/userdata",
    );
    const expectedUrl = `${pathToFileURL("/abs/slides/index.html").href}?print-pdf`;
    expect(args).toContain("--headless=new");
    expect(args).toContain("--disable-gpu");
    expect(args).toContain("--no-pdf-header-footer");
    expect(args).toContain("--allow-file-access-from-files");
    expect(args).toContain("--user-data-dir=/tmp/userdata");
    expect(args).toContain("--print-to-pdf=/abs/out.pdf");
    expect(args).toContain(expectedUrl);
  });

  it("escapes path with spaces via pathToFileURL (Major M5)", () => {
    const args = buildChromiumArgs(
      "/abs/dir with space/slides/index.html",
      "/abs/out.pdf",
      "/tmp/userdata",
    );
    const expectedUrl = `${pathToFileURL("/abs/dir with space/slides/index.html").href}?print-pdf`;
    expect(args).toContain(expectedUrl);
    // 素朴な "file://" + path ではない
    expect(args).not.toContain("file:///abs/dir with space/slides/index.html?print-pdf");
  });
});

describe("exportPdf", () => {
  let cleanupDirs: string[] = [];
  afterEach(async () => {
    for (const dir of cleanupDirs) {
      await rm(dir, { recursive: true, force: true });
    }
    cleanupDirs = [];
  });

  it("calls spawn with chromium path + writes the output via fake spawn", async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), "slaido-userdata-"));
    cleanupDirs.push(userDataDir);
    const outDir = await mkdtemp(join(tmpdir(), "slaido-pdfout-"));
    cleanupDirs.push(outDir);
    const outputPath = join(outDir, "out.pdf");

    let capturedCmd: string[] | null = null;
    const fakeSpawn: FakeSpawn = async (cmd) => {
      capturedCmd = cmd;
      // --print-to-pdf=<path> を抜き出してダミーバイトを書く
      const flag = cmd.find((s) => s.startsWith("--print-to-pdf="));
      if (flag) {
        const out = flag.slice("--print-to-pdf=".length);
        await writeFile(out, "%PDF-1.4\n%fake\n", "binary");
      }
      return { exitCode: 0, stderr: "" };
    };

    await exportPdf(
      {
        slidesEntry: SLIDES_FIXTURE,
        outputPath,
        chromiumPath: "/path/to/chrome",
        userDataDir,
      },
      { spawn: fakeSpawn },
    );

    expect(await Bun.file(outputPath).exists()).toBe(true);
    expect(capturedCmd).not.toBeNull();
    const cmd = capturedCmd!;
    expect(cmd[0]).toBe("/path/to/chrome");
    expect(cmd).toContain(`--user-data-dir=${userDataDir}`);
    expect(cmd).toContain(`--print-to-pdf=${outputPath}`);
    expect(cmd.some((s) => s.includes("?print-pdf"))).toBe(true);
  });

  it("throws PdfPrintError when chromium exits non-zero", async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), "slaido-userdata-"));
    cleanupDirs.push(userDataDir);
    const outDir = await mkdtemp(join(tmpdir(), "slaido-pdfout-"));
    cleanupDirs.push(outDir);
    const outputPath = join(outDir, "out.pdf");

    const fakeSpawn: FakeSpawn = async () => ({
      exitCode: 7,
      stderr: "boom",
    });

    await expect(
      exportPdf(
        {
          slidesEntry: SLIDES_FIXTURE,
          outputPath,
          chromiumPath: "/path/to/chrome",
          userDataDir,
        },
        { spawn: fakeSpawn },
      ),
    ).rejects.toBeInstanceOf(PdfPrintError);
  });

  it("throws PdfPrintError when output file is empty (0 byte)", async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), "slaido-userdata-"));
    cleanupDirs.push(userDataDir);
    const outDir = await mkdtemp(join(tmpdir(), "slaido-pdfout-"));
    cleanupDirs.push(outDir);
    const outputPath = join(outDir, "out.pdf");

    const fakeSpawn: FakeSpawn = async (cmd) => {
      const flag = cmd.find((s) => s.startsWith("--print-to-pdf="));
      if (flag) {
        await writeFile(flag.slice("--print-to-pdf=".length), "", "binary");
      }
      return { exitCode: 0, stderr: "" };
    };

    await expect(
      exportPdf(
        {
          slidesEntry: SLIDES_FIXTURE,
          outputPath,
          chromiumPath: "/path/to/chrome",
          userDataDir,
        },
        { spawn: fakeSpawn },
      ),
    ).rejects.toBeInstanceOf(PdfPrintError);
  });

  it("uses findChromium injection when chromiumPath is omitted", async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), "slaido-userdata-"));
    cleanupDirs.push(userDataDir);
    const outDir = await mkdtemp(join(tmpdir(), "slaido-pdfout-"));
    cleanupDirs.push(outDir);
    const outputPath = join(outDir, "out.pdf");

    let capturedCmd: string[] | null = null;
    const fakeSpawn: FakeSpawn = async (cmd) => {
      capturedCmd = cmd;
      const flag = cmd.find((s) => s.startsWith("--print-to-pdf="));
      if (flag) await writeFile(flag.slice("--print-to-pdf=".length), "PDF", "binary");
      return { exitCode: 0, stderr: "" };
    };

    await exportPdf(
      {
        slidesEntry: SLIDES_FIXTURE,
        outputPath,
        userDataDir,
      },
      {
        spawn: fakeSpawn,
        findChromium: async () => "/injected/chrome",
      },
    );

    expect(capturedCmd).not.toBeNull();
    expect(capturedCmd![0]).toBe("/injected/chrome");
  });

  it("throws ChromiumNotFoundError when no chromium and findChromium returns null", async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), "slaido-userdata-"));
    cleanupDirs.push(userDataDir);
    const outDir = await mkdtemp(join(tmpdir(), "slaido-pdfout-"));
    cleanupDirs.push(outDir);

    await expect(
      exportPdf(
        {
          slidesEntry: SLIDES_FIXTURE,
          outputPath: join(outDir, "out.pdf"),
          userDataDir,
        },
        { findChromium: async () => null },
      ),
    ).rejects.toBeInstanceOf(ChromiumNotFoundError);
  });
});

// env wrapper add-on test (plan §6.3 / §7.1 cycle 5 add-on)
describe("exportPdf via SLAIDO_CHROME_PATH env wrapper script", () => {
  let cleanupDirs: string[] = [];
  const previousEnv = process.env.SLAIDO_CHROME_PATH;

  afterEach(async () => {
    if (previousEnv === undefined) delete process.env.SLAIDO_CHROME_PATH;
    else process.env.SLAIDO_CHROME_PATH = previousEnv;

    for (const dir of cleanupDirs) {
      await rm(dir, { recursive: true, force: true });
    }
    cleanupDirs = [];
  });

  it("real spawn against fake bash wrapper writes the output via SLAIDO_CHROME_PATH", async () => {
    const fakeDir = await mkdtemp(join(tmpdir(), "slaido-fake-chrome-"));
    cleanupDirs.push(fakeDir);
    const fakeChrome = join(fakeDir, "fake-chrome.sh");
    await writeFile(
      fakeChrome,
      [
        "#!/usr/bin/env bash",
        'for arg in "$@"; do',
        "  case \"$arg\" in",
        '    --print-to-pdf=*) printf "%%PDF-1.4\\nfake\\n" > "${arg#--print-to-pdf=}";;',
        "  esac",
        "done",
        "exit 0",
        "",
      ].join("\n"),
      "utf8",
    );
    await chmod(fakeChrome, 0o755);

    process.env.SLAIDO_CHROME_PATH = fakeChrome;

    const userDataDir = await mkdtemp(join(tmpdir(), "slaido-userdata-"));
    cleanupDirs.push(userDataDir);
    const outDir = await mkdtemp(join(tmpdir(), "slaido-pdfout-"));
    cleanupDirs.push(outDir);
    const outputPath = join(outDir, "out.pdf");

    await exportPdf({
      slidesEntry: SLIDES_FIXTURE,
      outputPath,
      chromiumPath: fakeChrome,
      userDataDir,
    });

    expect(await Bun.file(outputPath).exists()).toBe(true);
    const text = await Bun.file(outputPath).text();
    expect(text.startsWith("%PDF")).toBe(true);
  });
});

// fakeSpawn の型. PdfDeps.spawn と同じ shape.
type FakeSpawn = (
  cmd: string[],
  opts: { signal?: AbortSignal },
) => Promise<{ exitCode: number; stderr: string }>;
