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

  send({ type: "export-progress", kind: "pdf", phase: "start" });

  let outputPath: string | null;
  try {
    outputPath = await showDialog({ defaultName: `${req.title}.pdf`, filterExt: "pdf" });
  } catch (err) {
    send(toProgress("pdf", err));
    return;
  }
  if (outputPath === null) {
    send({ type: "export-progress", kind: "pdf", phase: "canceled", silent: true });
    return;
  }

  let userDataDir: string;
  try {
    userDataDir = await mkdtemp(join(tmpdir(), "slaido-pdf-userdata-"));
  } catch (err) {
    send(toProgress("pdf", err));
    return;
  }

  try {
    await runPdf({ slidesEntry: req.slidesEntry, outputPath, userDataDir });
    send({ type: "export-progress", kind: "pdf", phase: "done" });
  } catch (err) {
    send(toProgress("pdf", err));
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

  send({ type: "export-progress", kind: "html-zip", phase: "start" });

  let outputPath: string | null;
  try {
    outputPath = await showDialog({ defaultName: `${req.title}.zip`, filterExt: "zip" });
  } catch (err) {
    send(toProgress("html-zip", err));
    return;
  }
  if (outputPath === null) {
    send({
      type: "export-progress",
      kind: "html-zip",
      phase: "canceled",
      silent: true,
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
  } catch (err) {
    send(toProgress("html-zip", err));
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
