import { afterEach, describe, expect, it } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { ChromiumNotFoundError, PdfPrintError } from "./errors";
import { _makeDefaultSpawn, buildChromiumArgs, exportPdf } from "./pdf";

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

  // ---- T021 Cycle 1: opts に outputPath / killAfterMs が渡る ----
  it("passes outputPath and killAfterMs (default 60_000) to spawn opts (T021 cycle 1)", async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), "slaido-userdata-"));
    cleanupDirs.push(userDataDir);
    const outDir = await mkdtemp(join(tmpdir(), "slaido-pdfout-"));
    cleanupDirs.push(outDir);
    const outputPath = join(outDir, "out.pdf");

    let capturedOpts: SpawnOpts | null = null;
    const fakeSpawn: FakeSpawn = async (cmd, opts) => {
      capturedOpts = opts;
      const flag = cmd.find((s) => s.startsWith("--print-to-pdf="));
      if (flag) await writeFile(flag.slice("--print-to-pdf=".length), "%PDF-1.4\nfake\n", "binary");
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

    expect(capturedOpts).not.toBeNull();
    expect(capturedOpts!.outputPath).toBe(outputPath);
    expect(capturedOpts!.killAfterMs).toBe(60_000);
  });

  it("forwards explicit timeoutMs as killAfterMs (T021 cycle 1)", async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), "slaido-userdata-"));
    cleanupDirs.push(userDataDir);
    const outDir = await mkdtemp(join(tmpdir(), "slaido-pdfout-"));
    cleanupDirs.push(outDir);
    const outputPath = join(outDir, "out.pdf");

    let capturedOpts: SpawnOpts | null = null;
    const fakeSpawn: FakeSpawn = async (cmd, opts) => {
      capturedOpts = opts;
      const flag = cmd.find((s) => s.startsWith("--print-to-pdf="));
      if (flag) await writeFile(flag.slice("--print-to-pdf=".length), "%PDF-1.4\nfake\n", "binary");
      return { exitCode: 0, stderr: "" };
    };

    await exportPdf(
      {
        slidesEntry: SLIDES_FIXTURE,
        outputPath,
        chromiumPath: "/path/to/chrome",
        userDataDir,
        timeoutMs: 12_345,
      },
      { spawn: fakeSpawn },
    );

    expect(capturedOpts).not.toBeNull();
    expect(capturedOpts!.killAfterMs).toBe(12_345);
  });

  // ---- T021 Cycle 4: killedByUs=true は非ゼロ exit code を許容 ----
  it("tolerates non-zero exit code when spawn reports killedByUs=true (T021 cycle 4)", async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), "slaido-userdata-"));
    cleanupDirs.push(userDataDir);
    const outDir = await mkdtemp(join(tmpdir(), "slaido-pdfout-"));
    cleanupDirs.push(outDir);
    const outputPath = join(outDir, "out.pdf");

    const fakeSpawn: FakeSpawn = async (cmd) => {
      const flag = cmd.find((s) => s.startsWith("--print-to-pdf="));
      if (flag) await writeFile(flag.slice("--print-to-pdf=".length), "%PDF-1.4\nfake\n", "binary");
      // SIGTERM 由来 exit code 143 を返す (kill された)
      return { exitCode: 143, stderr: "", killedByUs: true };
    };

    // killedByUs=true なので exit code 143 でも throw しない
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
  });
});

// ---- T021 Cycle 2 / Cycle 3: defaultSpawn 内部の kill / timeout 動作 ----
describe("_makeDefaultSpawn (T021 inner spawn behavior)", () => {
  let cleanupDirs: string[] = [];
  afterEach(async () => {
    for (const dir of cleanupDirs) {
      await rm(dir, { recursive: true, force: true });
    }
    cleanupDirs = [];
  });

  /**
   * Bun.Subprocess を最小限 mock する. stdout/stderr の controller を保持し
   * kill() で stream を close → exited を resolve させる.
   */
  function makeMockProc() {
    let stdoutCtrl!: ReadableStreamDefaultController<Uint8Array>;
    let stderrCtrl!: ReadableStreamDefaultController<Uint8Array>;
    let exitedResolve!: (n: number) => void;
    const stdout = new ReadableStream<Uint8Array>({
      start(c) {
        stdoutCtrl = c;
      },
    });
    const stderr = new ReadableStream<Uint8Array>({
      start(c) {
        stderrCtrl = c;
      },
    });
    const exited = new Promise<number>((res) => {
      exitedResolve = res;
    });
    const killCalls: number[] = [];
    let closed = false;
    const closeStreams = () => {
      if (closed) return;
      closed = true;
      try {
        stdoutCtrl.close();
      } catch {}
      try {
        stderrCtrl.close();
      } catch {}
    };
    const proc = {
      stdout,
      stderr,
      exited,
      kill(signal?: number) {
        killCalls.push(signal ?? -1);
        // SIGTERM/SIGKILL いずれでも 10ms 後に exit する mock 動作
        closeStreams();
        const code = signal === 9 ? 137 : 143;
        setTimeout(() => exitedResolve(code), 10);
      },
    };
    return { proc, killCalls };
  }

  // Cycle 2: PDF 出現 → 500ms grace 後 SIGTERM
  it("kills the proc with SIGTERM after PDF appears (with grace)", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "slaido-pdfspawn-"));
    cleanupDirs.push(outDir);
    const outputPath = join(outDir, "out.pdf");

    const { proc, killCalls } = makeMockProc();
    const fakeSpawnImpl = ((_cmd: string[], _opts: unknown) => proc) as unknown as Parameters<
      typeof _makeDefaultSpawn
    >[0];
    const innerSpawn = _makeDefaultSpawn(fakeSpawnImpl);

    // Spawn が始まってから 300ms 後に PDF を書く. polling (200ms) で検知 → 500ms grace → kill
    setTimeout(() => {
      void writeFile(outputPath, "%PDF-1.4\nfake\n", "binary").catch(() => {});
    }, 300);

    const start = Date.now();
    const result = await innerSpawn(["/fake/chrome", `--print-to-pdf=${outputPath}`], {
      outputPath,
      killAfterMs: 10_000,
    });
    const elapsed = Date.now() - start;

    expect(killCalls.length).toBeGreaterThan(0);
    expect(killCalls[0]).toBe(15); // SIGTERM
    expect(result.killedByUs).toBe(true);
    // grace を尊重: PDF 書き込み (300ms) + grace (500ms) = 800ms 以上, killAfterMs より十分早い
    expect(elapsed).toBeGreaterThanOrEqual(700);
    expect(elapsed).toBeLessThan(5_000);
  }, 15_000);

  // Cycle 3: 絶対 timeout で SIGKILL → PdfPrintError throw
  it("throws PdfPrintError with SIGKILL when chrome does not exit within killAfterMs", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "slaido-pdfspawn-"));
    cleanupDirs.push(outDir);
    // outputPath は存在しない (PDF を書かない) ので polling は発火しない
    const outputPath = join(outDir, "out.pdf");

    const { proc, killCalls } = makeMockProc();
    const fakeSpawnImpl = ((_cmd: string[], _opts: unknown) => proc) as unknown as Parameters<
      typeof _makeDefaultSpawn
    >[0];
    const innerSpawn = _makeDefaultSpawn(fakeSpawnImpl);

    let thrown: unknown = null;
    try {
      await innerSpawn(["/fake/chrome", `--print-to-pdf=${outputPath}`], {
        outputPath,
        killAfterMs: 200,
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(PdfPrintError);
    expect((thrown as Error).message).toMatch(/did not exit|timeout/i);
    expect(killCalls).toContain(9); // SIGKILL
  }, 5_000);
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

// fakeSpawn の opts/return shape. PdfDeps.spawn と同じ.
type SpawnOpts = {
  signal?: AbortSignal;
  outputPath?: string;
  killAfterMs?: number;
};
type FakeSpawn = (
  cmd: string[],
  opts: SpawnOpts,
) => Promise<{ exitCode: number; stderr: string; killedByUs?: boolean }>;
