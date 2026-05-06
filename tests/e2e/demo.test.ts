/**
 * E2E demo: examples/DEMO.md の 7 ステップを通しで自動検証する。
 *
 * 前提:
 *   - macOS GUI 環境
 *   - Keychain `dev.slaido.app/openrouter` に OpenRouter API キーが保存済み
 *
 * 実行: `bun test tests/e2e/demo.test.ts`
 *
 * カバー範囲:
 *   1. アプリ起動 (bun run start) → ウィンドウ・ペイン表示
 *   2. シード投入 → 「スライドを生成」 → assistant メッセージ受信
 *   3. プレビュー iframe にスライドが描画されている (section >= 3)
 *   4. チャットで部分修正指示 → 2 個目の assistant メッセージ
 *   5. HTML zip エクスポート → ファイル生成
 *   6. PDF エクスポート → ファイル生成
 *
 * ステップ 5 / 6 のネイティブ保存ダイアログは SLAIDO_E2E_EXPORT_DIR で
 * バイパスされる (src/bun/index.ts: buildE2eShowSaveDialog)。
 *
 * 注意: ~/Library/Application Support/slAIdo/ の projects と last-opened.json を
 *      テスト実行中だけ退避し、afterAll で復元する。SIGKILL 等で異常終了した場合、
 *      次回起動時の beforeAll が残った退避ファイルを自動的に復元する。
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawn, type Subprocess } from "bun";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { BunMot } from "bun-mot";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const BRIDGE_PORT = 4747;
const READY_TIMEOUT_MS = 90_000;
const ASSERT_TIMEOUT_MS = 180_000; // LLM 生成は数十秒〜2 分。tool chain 込みで余裕
const EXPORT_PDF_TIMEOUT_MS = 120_000; // chromium spawn + PDF 出力は重い

const APP_DATA_ROOT = join(homedir(), "Library", "Application Support", "slAIdo");
const PROJECTS_DIR = join(APP_DATA_ROOT, "projects");
const LAST_OPENED_FILE = join(APP_DATA_ROOT, "last-opened.json");
const BACKUP_SUFFIX = ".e2e-backup";

const EXPORT_DIR = mkdtempSync(join(tmpdir(), "slaido-e2e-export-"));

let app: Subprocess | null = null;
let mot: BunMot;
let appLog = "";

function stashUserDataForFreshStart(): void {
  // 前回の異常終了で残っている退避を先に復元
  restoreUserDataIfStashed();
  if (existsSync(PROJECTS_DIR)) {
    renameSync(PROJECTS_DIR, PROJECTS_DIR + BACKUP_SUFFIX);
  }
  if (existsSync(LAST_OPENED_FILE)) {
    renameSync(LAST_OPENED_FILE, LAST_OPENED_FILE + BACKUP_SUFFIX);
  }
}

function restoreUserDataIfStashed(): void {
  if (existsSync(PROJECTS_DIR + BACKUP_SUFFIX)) {
    if (existsSync(PROJECTS_DIR)) {
      rmSync(PROJECTS_DIR, { recursive: true, force: true });
    }
    renameSync(PROJECTS_DIR + BACKUP_SUFFIX, PROJECTS_DIR);
  }
  if (existsSync(LAST_OPENED_FILE + BACKUP_SUFFIX)) {
    if (existsSync(LAST_OPENED_FILE)) {
      rmSync(LAST_OPENED_FILE);
    }
    renameSync(LAST_OPENED_FILE + BACKUP_SUFFIX, LAST_OPENED_FILE);
  }
}

async function waitForFile(
  path: string,
  timeoutMs: number,
  pollMs = 500,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path) && statSync(path).size > 0) return;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new Error(
    `waitForFile timed out after ${timeoutMs}ms: ${path}\n--- app log (last 2000 chars) ---\n${appLog.slice(-2000)}`,
  );
}

beforeAll(async () => {
  stashUserDataForFreshStart();

  app = spawn({
    cmd: ["bun", "run", "start"],
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      BUN_MOT_PORT: String(BRIDGE_PORT),
      SLAIDO_E2E_EXPORT_DIR: EXPORT_DIR,
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdoutReader = app.stdout.getReader();
  const stderrReader = app.stderr.getReader();
  const decoder = new TextDecoder();

  // stdout / stderr の双方を最後まで読み続ける必要がある (ready 検知後に reader を
  // 止めると pipe バッファが詰まり、bun-mot の console.log ログが block して RPC が
  // 応答しなくなる)。ready は appLog から判定する。
  let readyResolved = false;
  let readyResolve: () => void = () => {};
  let readyReject: (e: Error) => void = () => {};
  const ready = new Promise<void>((res, rej) => {
    readyResolve = res;
    readyReject = rej;
  });

  void (async () => {
    while (true) {
      const { value, done } = await stderrReader.read();
      if (done) break;
      appLog += decoder.decode(value);
    }
  })();

  void (async () => {
    while (true) {
      const { value, done } = await stdoutReader.read();
      if (done) {
        if (!readyResolved) {
          readyReject(new Error("app exited before bridge ready"));
        }
        break;
      }
      appLog += decoder.decode(value);
      if (!readyResolved && appLog.includes("fixture-bridge-ready")) {
        readyResolved = true;
        readyResolve();
      }
    }
  })();

  const readyTimer = setTimeout(() => {
    if (!readyResolved) {
      readyReject(
        new Error(
          `bridge not ready in ${READY_TIMEOUT_MS}ms\n--- log ---\n${appLog.slice(-2000)}`,
        ),
      );
    }
  }, READY_TIMEOUT_MS);

  try {
    await ready;
  } finally {
    clearTimeout(readyTimer);
  }
  mot = new BunMot({ port: BRIDGE_PORT, defaultTimeout: ASSERT_TIMEOUT_MS });
}, READY_TIMEOUT_MS + 30_000);

afterAll(async () => {
  if (app) {
    app.kill("SIGTERM");
    await Promise.race([app.exited, new Promise((r) => setTimeout(r, 2000))]);
    app.kill("SIGKILL");
  }
  // テストで作られた fresh な projects は捨てて元に戻す
  if (existsSync(PROJECTS_DIR)) {
    rmSync(PROJECTS_DIR, { recursive: true, force: true });
  }
  if (existsSync(LAST_OPENED_FILE)) {
    rmSync(LAST_OPENED_FILE);
  }
  restoreUserDataIfStashed();

  // エクスポート tempdir 掃除
  rmSync(EXPORT_DIR, { recursive: true, force: true });

  // T021 defense-in-depth: defaultSpawn の kill が抜けても zombie Chrome を残さない.
  // パターンは "--print-to-pdf" を必須にして通常の Chrome ブラウザを巻き込まない.
  try {
    const pkill = spawn({
      cmd: ["pkill", "-f", "--print-to-pdf"],
      stdout: "ignore",
      stderr: "ignore",
    });
    await Promise.race([pkill.exited, new Promise((r) => setTimeout(r, 2000))]);
  } catch {
    // pkill が無い環境でも fail しない
  }
});

// LLM 生成 + 修正 + エクスポート x2 で長くなる。余裕を持たせる。
const TEST_TIMEOUT_MS =
  READY_TIMEOUT_MS + ASSERT_TIMEOUT_MS * 2 + EXPORT_PDF_TIMEOUT_MS + 60_000;

test("DEMO.md 全工程: seed → generate → refine → export-zip → export-pdf", async () => {
  // ---- step 1: 起動確認 ----
  await mot.waitForSelector("#seed-input", { timeout: 30_000 });
  const modalHidden = await mot.evaluate(
    `document.getElementById('api-key-modal').classList.contains('hidden')`,
  );
  expect(modalHidden).toBe(true);

  // body の data-phase が "loading" → "seed" に遷移するのを待つ
  await mot.waitForSelector(`body[data-phase="seed"]`, { timeout: 30_000 });

  // ---- step 2: seed 投入 → generate ----
  // T019 で #generate-btn は interview 経路に変わったため、
  // 旧 flow を直接検証する e2e は #generate-skip-link を使う。
  // interview flow 自体の e2e は別途追加する想定。
  const seed = await readFile(join(REPO_ROOT, "examples", "seed-meta.md"), "utf8");
  await mot.fill("#seed-input", seed);
  await mot.click("#generate-skip-link");

  try {
    await mot.waitForSelector("#chat-messages .message.assistant", {
      timeout: ASSERT_TIMEOUT_MS,
    });
  } catch (err) {
    console.error("---- app log on failure (last 4000 chars) ----");
    console.error(appLog.slice(-4000));
    console.error("---- end app log ----");
    throw err;
  }

  // ---- step 3: スライドが描画されていること ----
  // generate 後は body[data-phase="chat"] へ遷移している
  await mot.waitForSelector(`body[data-phase="chat"]`, { timeout: 10_000 });

  // iframe contentDocument は cross-origin (views:// vs file://) で読めないので、
  // disk 上の slides/index.html を直接読んで <section> 数を確認する。
  // fresh start なので PROJECTS_DIR には今作ったプロジェクト 1 つのみ。
  const projectDirs = (await import("node:fs")).readdirSync(PROJECTS_DIR);
  expect(projectDirs.length).toBe(1);
  const slidesPath = join(PROJECTS_DIR, projectDirs[0]!, "slides", "index.html");
  // LLM の Write ツール実行完了 → preview_sync_reload までを待つ。
  // bridge.sendMessage は応答完了まで await するため、generate_sent 出現で確実。
  let slideCount = 0;
  const slideDeadline = Date.now() + ASSERT_TIMEOUT_MS;
  while (Date.now() < slideDeadline) {
    if (existsSync(slidesPath)) {
      const html = await readFile(slidesPath, "utf8");
      slideCount = (html.match(/<section[\s>]/g) ?? []).length;
      if (slideCount >= 3) break;
    }
    if (appLog.includes("generate_failed")) {
      throw new Error(
        `generate_failed in app log\n--- log ---\n${appLog.slice(-2000)}`,
      );
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (slideCount < 3) {
    console.error("---- last assistant message (truncated) ----");
    const msgText = await mot.evaluate(
      `(() => { const els = document.querySelectorAll('#chat-messages .message.assistant'); return els.length ? els[els.length-1].textContent.slice(0, 2000) : '(no assistant message)'; })()`,
    );
    console.error(msgText);
    console.error("---- slides on disk ----");
    if (existsSync(slidesPath)) {
      console.error(await readFile(slidesPath, "utf8"));
    } else {
      console.error("(slides file not found at " + slidesPath + ")");
    }
    console.error("---- app log (last 4000 chars) ----");
    console.error(appLog.slice(-4000));
  }
  expect(slideCount).toBeGreaterThanOrEqual(3);

  // iframe 内部 DOM を完全 probe (allow-same-origin で contentDocument にアクセス可)
  // reveal.js が初期化されているかを Reveal API + DOM 状態で判定する。
  await new Promise((r) => setTimeout(r, 2000)); // reveal.js 初期化待ち
  const previewState = await mot.evaluate(`(() => {
    const iframe = document.getElementById('preview-iframe');
    if (!iframe) return JSON.stringify({error: 'no preview-iframe element'});
    const result = {
      srcdocLen: (iframe.getAttribute('srcdoc') || '').length,
      hasSrc: !!iframe.getAttribute('src'),
      iframeRect: (() => { const r = iframe.getBoundingClientRect(); return {x:r.x, y:r.y, w:r.width, h:r.height}; })(),
      iframeStyle: { display: getComputedStyle(iframe).display, visibility: getComputedStyle(iframe).visibility, opacity: getComputedStyle(iframe).opacity },
      previewStatus: document.getElementById('preview-status')?.textContent,
      previewPaneRect: (() => { const p = document.getElementById('preview-pane'); if (!p) return null; const r = p.getBoundingClientRect(); return {w:r.width, h:r.height}; })(),
      appRect: (() => { const a = document.getElementById('app'); if (!a) return null; const r = a.getBoundingClientRect(); return {w:r.width, h:r.height}; })(),
      windowSize: { innerWidth: window.innerWidth, innerHeight: window.innerHeight, devicePixelRatio: window.devicePixelRatio },
      bodyHtmlSize: { bodyH: document.body.getBoundingClientRect().height, htmlH: document.documentElement.getBoundingClientRect().height },
    };
    try {
      const doc = iframe.contentDocument;
      const win = iframe.contentWindow;
      if (!doc || !win) {
        result.contentAccessError = 'no contentDocument/Window';
        return JSON.stringify(result);
      }
      result.docTitle = doc.title;
      result.docReadyState = doc.readyState;
      result.bodyTagCount = doc.body.children.length;
      result.bodyClassList = Array.from(doc.body.classList);
      result.bodyBg = getComputedStyle(doc.body).backgroundColor;
      result.bodyW = doc.body.getBoundingClientRect().width;
      result.bodyH = doc.body.getBoundingClientRect().height;
      result.htmlClassList = Array.from(doc.documentElement.classList);
      const reveal = doc.querySelector('.reveal');
      result.revealExists = !!reveal;
      result.revealClassList = reveal ? Array.from(reveal.classList) : null;
      result.revealRect = reveal ? (() => { const r = reveal.getBoundingClientRect(); return {w:r.width, h:r.height, x:r.x, y:r.y}; })() : null;
      result.sectionCount = doc.querySelectorAll('.reveal .slides > section').length;
      const presentSec = doc.querySelector('.reveal section.present');
      result.presentSectionExists = !!presentSec;
      result.presentSectionRect = presentSec ? (() => { const r = presentSec.getBoundingClientRect(); return {w:r.width, h:r.height, x:r.x, y:r.y}; })() : null;
      result.presentSectionText = presentSec ? presentSec.textContent.slice(0, 200) : null;
      result.RevealGlobal = typeof win.Reveal;
      if (win.Reveal && typeof win.Reveal.isReady === 'function') {
        result.RevealReady = win.Reveal.isReady();
      }
      result.styleSheetCount = doc.styleSheets.length;
      result.firstStylesheetRules = doc.styleSheets[0] ? doc.styleSheets[0].cssRules.length : null;
      // 直接 DOM レンダリング状態を確かめる: 全 section の text を一覧
      result.sectionTitles = Array.from(doc.querySelectorAll('.reveal .slides > section'))
        .slice(0, 5)
        .map((s) => (s.querySelector('h1, h2, h3') || s).textContent.trim().slice(0, 60));
    } catch (e) {
      result.contentAccessError = String(e);
    }
    return JSON.stringify(result, null, 2);
  })()`);
  console.log("[e2e iframe-deep-probe]", previewState);

  // visual sanity: Reveal.js が初期化済 & first slide が iframe viewport 内にあること
  const probe = JSON.parse(String(previewState));
  expect(probe.RevealReady).toBe(true);
  expect(probe.sectionCount).toBeGreaterThanOrEqual(3);
  // present section が iframe height 内に収まっている = ユーザに見える位置
  expect(probe.presentSectionRect.y).toBeLessThan(probe.iframeRect.h);

  // ---- step 4: チャットで部分修正 ----
  // slides ファイル生成完了 ≠ bridge.sendMessage 完了 のため、
  // refine を送る前に opencode log の slaido_generate_end 出現を待つ。
  // 待たないと generate が refine に supersede され generate_end が emit されない。
  {
    const opencodeLogDir = join(homedir(), ".local", "share", "opencode", "log");
    const generateEndDeadline = Date.now() + ASSERT_TIMEOUT_MS;
    let generateEnded = false;
    while (Date.now() < generateEndDeadline) {
      const logFiles = readdirSync(opencodeLogDir)
        .filter((f) => f.endsWith(".log"))
        .map((f) => {
          const p = join(opencodeLogDir, f);
          return { path: p, mtimeMs: statSync(p).mtimeMs };
        })
        .sort((a, b) => b.mtimeMs - a.mtimeMs);
      const latest = logFiles[0]?.path;
      if (latest) {
        const content = await readFile(latest, "utf8");
        if (content.includes("slaido_generate_end")) {
          generateEnded = true;
          break;
        }
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    expect(generateEnded, "expected slaido_generate_end before refine").toBe(true);
  }

  const refineMsg = "タイトルスライドのサブタイトルを『Mac App Store ready』に変えて";
  await mot.fill("#chat-input", refineMsg);
  await mot.click("#send-btn");

  // refine の user メッセージ + 新しい assistant メッセージが出るまで polling。
  // generate だけで assistant が複数 (text + tool-status step) 出るので、
  // refine 投入前の count をベースラインとして増分を待つ。
  const baseAssistantCount = Number(
    await mot.evaluate(
      `document.querySelectorAll('#chat-messages .message.assistant').length`,
    ),
  );
  const assistantDeadline = Date.now() + ASSERT_TIMEOUT_MS;
  let assistantCount = baseAssistantCount;
  while (Date.now() < assistantDeadline) {
    assistantCount = Number(
      await mot.evaluate(
        `document.querySelectorAll('#chat-messages .message.assistant').length`,
      ),
    );
    if (assistantCount > baseAssistantCount) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  expect(assistantCount).toBeGreaterThan(baseAssistantCount);

  // chat-messages の user 表示を確認: プロンプト全文 (HTML タグ含む) ではなく
  // placeholder と簡潔な user 入力のみが表示されているべき
  const chatDump = await mot.evaluate(`(() => {
    const messages = Array.from(document.querySelectorAll('#chat-messages .message'));
    return JSON.stringify(messages.map((m) => ({
      role: m.classList.contains('user') ? 'user' : (m.classList.contains('assistant') ? 'assistant' : 'other'),
      textPrefix: m.textContent.trim().slice(0, 200),
      textLen: m.textContent.trim().length,
    })));
  })()`);
  console.log("[e2e chat-dump]", chatDump);
  const chatMessages = JSON.parse(String(chatDump));
  // user メッセージにプロンプト指示文 (`制約:` `<head>:` 等) が含まれていないこと
  const userTexts = chatMessages.filter((m: { role: string }) => m.role === "user");
  for (const u of userTexts) {
    expect(u.textPrefix).not.toContain("制約:");
    expect(u.textPrefix).not.toContain("<head>");
    expect(u.textPrefix).not.toContain("dist/reset.css");
  }

  // ---- step 5: HTML zip export ----
  // SLAIDO_E2E_EXPORT_DIR があれば showSaveDialog バイパスで即出力される
  // (defaultName は project.meta.title。Untitled の可能性が高い)
  await mot.click("#export-html-zip-btn");
  // 候補ファイル: Untitled.zip など。dir 内のいずれかの .zip を待つ
  const zipPath = join(EXPORT_DIR, "Untitled.zip");
  await waitForFile(zipPath, 60_000);

  // ---- step 6: PDF export ----
  await mot.click("#export-pdf-btn");
  const pdfPath = join(EXPORT_DIR, "Untitled.pdf");
  await waitForFile(pdfPath, EXPORT_PDF_TIMEOUT_MS);

  // ---- step 7: opencode セッションログへの slaido メタデータ inject 検証 ----
  // T016. `~/.local/share/opencode/log/<latest>.log` に `service=slaido` 行が並び,
  // 主要ライフサイクルイベントが extra フィールド付きで現れていることを確認する.
  //
  // 出力形式 (実機で 1 度叩いて確認済): flat key=value, extra は prefix 無し.
  //   `INFO  2026-05-02T14:46:37 +2ms service=slaido slaidoVersion=0.1.0 projectId=p1 slaido_generate_start`
  //
  // 注: `slaido_started` は bootstrap 冒頭で transcript.log を撃つが, この時点では
  // chat-bridge が未 init で client が null のため drop される (plan §2.4.2).
  // よって opencode log には載らない. assertion からは外し, main.log の
  // `transcript_log_failed reason=client_unavailable` warn 経由でだけ検知できる.
  const opencodeLogDir = join(homedir(), ".local", "share", "opencode", "log");
  const logFiles = readdirSync(opencodeLogDir)
    .filter((f) => f.endsWith(".log"))
    .map((f) => {
      const p = join(opencodeLogDir, f);
      return { path: p, mtimeMs: statSync(p).mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  expect(logFiles.length).toBeGreaterThan(0);
  const latestLogPath = logFiles[0]!.path;
  const latestLogContent = await readFile(latestLogPath, "utf8");
  const slaidoLines = latestLogContent
    .split("\n")
    .filter((line) => line.includes("service=slaido"));
  console.log("[e2e opencode-log]", latestLogPath, "slaido lines:", slaidoLines.length);

  const requiredEvents = [
    "slaido_opencode_ready",
    "slaido_generate_start",
    "slaido_generate_end",
    "slaido_export_pdf_start",
    "slaido_export_pdf_end",
  ];
  // waitForFile (PDF) は file 出現で戻るが log emit はその直後で
  // 検証時にまだ書き込まれていないことがある。最大 120s poll する。
  // (PDF export は Chrome cleanup を含めて await runPdf 完了が遅れるケースあり)
  let polledLines = slaidoLines;
  const eventDeadline = Date.now() + 120_000;
  while (Date.now() < eventDeadline) {
    const allFound = requiredEvents.every((ev) =>
      polledLines.some((line) => line.includes(ev)),
    );
    if (allFound) break;
    await new Promise((r) => setTimeout(r, 500));
    const refreshed = await readFile(latestLogPath, "utf8");
    polledLines = refreshed.split("\n").filter((line) => line.includes("service=slaido"));
  }
  for (const ev of requiredEvents) {
    const found = polledLines.some((line) => line.includes(ev));
    if (!found) {
      console.error(`[e2e missing event] ${ev} in ${latestLogPath}`);
      console.error("--- slaido lines ---");
      console.error(polledLines.join("\n"));
    }
    expect(found, `expected ${ev} in ${latestLogPath}`).toBe(true);
  }

  // baseExtra (slaidoVersion) と perEventExtra (projectId) が flat key=value で並ぶこと.
  expect(polledLines.some((line) => /\bslaidoVersion=/.test(line))).toBe(true);
  const projectIdLines = polledLines.filter((line) => /\bprojectId=/.test(line));
  // 完了条件: 同一 projectId の行が 5 件以上 (1 セッション横断 grep が成り立つこと).
  expect(projectIdLines.length).toBeGreaterThanOrEqual(5);

  await mot.pass("DEMO.md 全工程通過");
}, TEST_TIMEOUT_MS);
