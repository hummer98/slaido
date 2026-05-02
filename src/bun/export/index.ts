/**
 * orchestrator — main process から呼ばれる薄いラッパ.
 *
 *  1. NSSavePanel を出して outputPath を得る
 *  2. exportPdf / exportHtmlZip を実行
 *  3. ServerMessage `export-progress` を `start` / `done` / `error` / `canceled` の
 *     形で送り出す.
 *
 * 関数注入 (showSaveDialog / runPdf / runHtmlZip / send) でテスト容易性を確保.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type ExportErrorCategory,
  toExportError,
} from "./errors";
import { exportHtmlZip as defaultExportHtmlZip } from "./html-zip";
import { exportPdf as defaultExportPdf } from "./pdf";
import { showSaveDialog as defaultShowSaveDialog } from "./save-dialog";
import type { TranscriptLoggerLike } from "../opencode/transcript";

export type ExportKind = "pdf" | "html-zip";

export interface ExportProgressMessage {
  type: "export-progress";
  kind: ExportKind;
  phase: "start" | "done" | "error" | "canceled";
  message?: string;
  category?: ExportErrorCategory;
  silent?: boolean;
}

export interface RunPdfArgs {
  slidesEntry: string;
  outputPath: string;
  userDataDir: string;
}

export interface RunHtmlZipArgs {
  slidesDir: string;
  templateRoot: string;
  outputPath: string;
  title: string;
}

export interface ExportOrchestratorDeps {
  send: (msg: ExportProgressMessage) => void;
  showSaveDialog?: (opts: {
    defaultName: string;
    filterExt: string;
  }) => Promise<string | null>;
  runPdf?: (args: RunPdfArgs) => Promise<void>;
  runHtmlZip?: (args: RunHtmlZipArgs) => Promise<void>;
  /**
   * opencode セッションログへ slaido メタデータを inject する logger.
   * 未指定なら export start / done / error / canceled の transcript log は出さない.
   */
  transcript?: TranscriptLoggerLike;
  /**
   * transcript.log の extra に常に積みたいフィールド (主に projectId).
   * 既存テストへの影響を抑えるため optional.
   */
  extra?: Record<string, unknown>;
}

export interface PdfRequest {
  title: string;
  slidesEntry: string;
  templateRoot: string;
}

export interface HtmlZipRequest {
  title: string;
  slidesDir: string;
  templateRoot: string;
}

async function defaultRunPdf(args: RunPdfArgs): Promise<void> {
  await defaultExportPdf({
    slidesEntry: args.slidesEntry,
    outputPath: args.outputPath,
    userDataDir: args.userDataDir,
  });
}

async function defaultRunHtmlZip(args: RunHtmlZipArgs): Promise<void> {
  await defaultExportHtmlZip({
    slidesDir: args.slidesDir,
    distDir: join(args.templateRoot, "dist"),
    outputPath: args.outputPath,
    title: args.title,
  });
}

const wrappedShowSaveDialog: NonNullable<ExportOrchestratorDeps["showSaveDialog"]> = (
  opts,
) =>
  defaultShowSaveDialog({
    defaultName: opts.defaultName,
    filterExt: opts.filterExt,
  });

export async function handleExportPdf(
  req: PdfRequest,
  deps: ExportOrchestratorDeps,
): Promise<void> {
  const { send } = deps;
  const showDialog = deps.showSaveDialog ?? wrappedShowSaveDialog;
  const runPdf = deps.runPdf ?? defaultRunPdf;
  const baseExtra: Record<string, unknown> = {
    kind: "pdf",
    projectTitle: req.title,
    ...(deps.extra ?? {}),
  };
  const startedAt = Date.now();

  send({ type: "export-progress", kind: "pdf", phase: "start" });
  deps.transcript?.log("slaido_export_pdf_start", {
    ...baseExtra,
    phase: "start",
  });

  let outputPath: string | null;
  try {
    outputPath = await showDialog({ defaultName: `${req.title}.pdf`, filterExt: "pdf" });
  } catch (err) {
    send(toProgress("pdf", err));
    deps.transcript?.error("slaido_export_pdf_failed", err, {
      ...baseExtra,
      phase: "error",
      durationMs: Date.now() - startedAt,
    });
    return;
  }
  if (outputPath === null) {
    send({ type: "export-progress", kind: "pdf", phase: "canceled", silent: true });
    deps.transcript?.log("slaido_export_pdf_canceled", {
      ...baseExtra,
      phase: "canceled",
      durationMs: Date.now() - startedAt,
    });
    return;
  }

  let userDataDir: string;
  try {
    userDataDir = await mkdtemp(join(tmpdir(), "slaido-pdf-userdata-"));
  } catch (err) {
    send(toProgress("pdf", err));
    deps.transcript?.error("slaido_export_pdf_failed", err, {
      ...baseExtra,
      phase: "error",
      durationMs: Date.now() - startedAt,
    });
    return;
  }

  try {
    await runPdf({ slidesEntry: req.slidesEntry, outputPath, userDataDir });
    send({ type: "export-progress", kind: "pdf", phase: "done" });
    deps.transcript?.log("slaido_export_pdf_end", {
      ...baseExtra,
      phase: "end",
      durationMs: Date.now() - startedAt,
    });
  } catch (err) {
    send(toProgress("pdf", err));
    deps.transcript?.error("slaido_export_pdf_failed", err, {
      ...baseExtra,
      phase: "error",
      durationMs: Date.now() - startedAt,
    });
  } finally {
    await rm(userDataDir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function handleExportHtmlZip(
  req: HtmlZipRequest,
  deps: ExportOrchestratorDeps,
): Promise<void> {
  const { send } = deps;
  const showDialog = deps.showSaveDialog ?? wrappedShowSaveDialog;
  const runHtmlZip = deps.runHtmlZip ?? defaultRunHtmlZip;
  const baseExtra: Record<string, unknown> = {
    kind: "html-zip",
    projectTitle: req.title,
    ...(deps.extra ?? {}),
  };
  const startedAt = Date.now();

  send({ type: "export-progress", kind: "html-zip", phase: "start" });
  deps.transcript?.log("slaido_export_html_zip_start", {
    ...baseExtra,
    phase: "start",
  });

  let outputPath: string | null;
  try {
    outputPath = await showDialog({ defaultName: `${req.title}.zip`, filterExt: "zip" });
  } catch (err) {
    send(toProgress("html-zip", err));
    deps.transcript?.error("slaido_export_html_zip_failed", err, {
      ...baseExtra,
      phase: "error",
      durationMs: Date.now() - startedAt,
    });
    return;
  }
  if (outputPath === null) {
    send({
      type: "export-progress",
      kind: "html-zip",
      phase: "canceled",
      silent: true,
    });
    deps.transcript?.log("slaido_export_html_zip_canceled", {
      ...baseExtra,
      phase: "canceled",
      durationMs: Date.now() - startedAt,
    });
    return;
  }

  try {
    await runHtmlZip({
      slidesDir: req.slidesDir,
      templateRoot: req.templateRoot,
      outputPath,
      title: req.title,
    });
    send({ type: "export-progress", kind: "html-zip", phase: "done" });
    deps.transcript?.log("slaido_export_html_zip_end", {
      ...baseExtra,
      phase: "end",
      durationMs: Date.now() - startedAt,
    });
  } catch (err) {
    send(toProgress("html-zip", err));
    deps.transcript?.error("slaido_export_html_zip_failed", err, {
      ...baseExtra,
      phase: "error",
      durationMs: Date.now() - startedAt,
    });
  }
}

function toProgress(kind: ExportKind, err: unknown): ExportProgressMessage {
  const payload = toExportError(err);
  const msg: ExportProgressMessage = {
    type: "export-progress",
    kind,
    phase: payload.phase,
    category: payload.category,
  };
  if (payload.message) msg.message = payload.message;
  if (payload.silent) msg.silent = true;
  return msg;
}
