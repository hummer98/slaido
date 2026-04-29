/**
 * エクスポート系のエラークラス + ServerMessage 変換ヘルパ.
 * 各 cycle で必要なものだけ追加していき、最終 cycle 6 で `toExportError()` を仕上げる.
 */

export class ZipFailedError extends Error {
  readonly code = "zip_failed";
  readonly exitCode: number;
  constructor(message: string, exitCode: number) {
    super(message);
    this.name = "ZipFailedError";
    this.exitCode = exitCode;
  }
}
