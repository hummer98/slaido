/**
 * エクスポート系のエラークラス + ServerMessage 変換ヘルパ.
 *
 * カテゴリ列挙は plan §5.1, ServerMessage 表現は plan §4.4 / §5.4.
 *  - phase: "error" / "canceled"
 *  - silent: true なら UI 通知を出さない (ボタン状態だけ復帰)
 */

export class ChromiumNotFoundError extends Error {
  readonly code = "chromium_not_found";
  constructor(message = "Google Chrome / Edge / Brave / Chromium のいずれかをインストールしてください") {
    super(message);
    this.name = "ChromiumNotFoundError";
  }
}

export class PdfPrintError extends Error {
  readonly code = "print_failed";
  readonly exitCode: number;
  constructor(message: string, exitCode: number) {
    super(message);
    this.name = "PdfPrintError";
    this.exitCode = exitCode;
  }
}

export class ZipFailedError extends Error {
  readonly code = "zip_failed";
  readonly exitCode: number;
  constructor(message: string, exitCode: number) {
    super(message);
    this.name = "ZipFailedError";
    this.exitCode = exitCode;
  }
}

export class DialogCanceledError extends Error {
  readonly code = "dialog_canceled";
  constructor(message = "User canceled the save dialog") {
    super(message);
    this.name = "DialogCanceledError";
  }
}

export class MkdtempFailedError extends Error {
  readonly code = "mkdtemp_failed";
  constructor(message: string) {
    super(message);
    this.name = "MkdtempFailedError";
  }
}

export class OutputIsDirectoryError extends Error {
  readonly code = "output_is_directory";
  readonly path: string;
  constructor(path: string) {
    super(`保存先がディレクトリです: ${path}`);
    this.name = "OutputIsDirectoryError";
    this.path = path;
  }
}

export class CommandNotFoundError extends Error {
  readonly code = "command_not_found";
  readonly command: string;
  constructor(command: string) {
    super(`必要なシステムコマンドが見つかりません: ${command}`);
    this.name = "CommandNotFoundError";
    this.command = command;
  }
}

export type ExportErrorCategory =
  | "chromium_not_found"
  | "dialog_canceled"
  | "permission_denied"
  | "disk_full"
  | "print_failed"
  | "zip_failed"
  | "aborted"
  | "mkdtemp_failed"
  | "output_is_directory"
  | "command_not_found";

export interface ExportErrorPayload {
  phase: "error" | "canceled";
  silent?: boolean;
  message: string;
  category: ExportErrorCategory;
}

function errnoCode(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

/**
 * 任意の例外を ServerMessage 用 payload に変換する.
 *
 *  - 既知のエラークラス: instanceof で分岐
 *  - errno-like (`{ code: "ENOSPC" }` 等): code で判定
 *  - その他: print_failed として包む (フォールバック)
 */
export function toExportError(err: unknown): ExportErrorPayload {
  if (err instanceof ChromiumNotFoundError) {
    return { phase: "error", category: "chromium_not_found", message: err.message };
  }
  if (err instanceof DialogCanceledError) {
    return { phase: "canceled", category: "dialog_canceled", message: "", silent: true };
  }
  if (err instanceof PdfPrintError) {
    return { phase: "error", category: "print_failed", message: err.message };
  }
  if (err instanceof ZipFailedError) {
    return { phase: "error", category: "zip_failed", message: err.message };
  }
  if (err instanceof MkdtempFailedError) {
    return { phase: "error", category: "mkdtemp_failed", message: err.message };
  }
  if (err instanceof OutputIsDirectoryError) {
    return { phase: "error", category: "output_is_directory", message: err.message };
  }
  if (err instanceof CommandNotFoundError) {
    return { phase: "error", category: "command_not_found", message: err.message };
  }

  if (err instanceof Error) {
    if (err.name === "AbortError") {
      return { phase: "canceled", category: "aborted", message: "", silent: true };
    }
    const code = errnoCode(err);
    if (code === "ENOSPC") {
      return {
        phase: "error",
        category: "disk_full",
        message: "ディスクの空き容量が不足しています",
      };
    }
    if (code === "EACCES" || code === "EPERM") {
      return {
        phase: "error",
        category: "permission_denied",
        message: `保存先に書き込めません: ${err.message}`,
      };
    }
    if (code === "EISDIR") {
      return {
        phase: "error",
        category: "output_is_directory",
        message: err.message,
      };
    }
    return { phase: "error", category: "print_failed", message: err.message };
  }

  return { phase: "error", category: "print_failed", message: String(err) };
}
