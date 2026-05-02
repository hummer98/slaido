# slaido ロギングポリシー

`~/git/cmux-team/skills/cmux-team/manager/logger.ts` の規約を移植したもの。
`src/bun/logger.ts` がこの方針の唯一の実装。`console.*` の直接呼び出しは原則禁止する。

## ログインターフェース

イベント名でレベルを区別せず、3 種類の API でレベル分岐する。

```typescript
import { log, warn, error } from "./logger";

await log("server_started", "port=50001");
await warn("preview_sync_stop_failed", `err=${(e as Error).message}`);
await error("host_message_handler_failed", `err=${(e as Error).message} stack=${(e as Error).stack ?? ""}`);
```

| API | 用途 |
|-----|------|
| `log(event, detail?)` | 通常イベント・状態遷移・ライフサイクル進捗 |
| `warn(event, detail?)` | 想定内の異常・best-effort 失敗・リトライ前の劣化 |
| `error(event, detail?)` | 例外捕捉・操作失敗・データ整合性逸脱 |

## フォーマット

```
[YYYY-MM-DDTHH:MM:SS+09:00] [level] event_name key1=value1 key2=value2
```

- タイムスタンプはローカル TZ オフセット付き ISO 8601。
- `info` レベルは `[level] ` プレフィックスを省略する（互換性維持）。
- `event` は `snake_case` で固定識別子（grep 可能性のため）。
- `detail` は `key=value` を半角空白区切りで並べる。値はクォートなし、ただし空白を含む値は `JSON.stringify` で囲む。

例:

```
[2026-05-01T19:51:23+09:00] server_started port=50001 host=127.0.0.1
[2026-05-01T19:52:01+09:00] [warn] preview_sync_stop_failed err="ENOENT: no such file"
[2026-05-01T19:52:30+09:00] [error] host_message_handler_failed err="invalid msg" stack="..."
```

## 必ずログすべきイベント

1. **例外捕捉時**: `catch` で処理する場合、最低限 `error("xxx_failed", \`err=${...}\`)` を残す。
2. **外部コマンド・外部プロセス失敗時**: `stderr` / `stdout` を必ず `detail` に含める（部分的なら冒頭〜数百文字）。
3. **ライフサイクル**: サーバ起動・停止、子プロセス spawn / kill、bridge 確立 / 切断。
4. **ユーザー操作起点の失敗**: 生成失敗、エクスポート失敗、API キー検証失敗など。

## 禁止事項

- **空の `catch {}`** — 必ず `error("xxx_failed", ...)` を残す。意図して握りつぶす場合もログ出力は必須。コメントで理由を添える。
- **機密情報のログ** — API キー全体・OAuth トークン・ユーザー入力の本文（seed 内容等）。最初の 4〜10 文字 + 文字数のみのマスク表示にとどめる。
- **`console.log` / `console.warn` / `console.error` の直接呼び出し** — 必ず `logger` 経由。例外として `logger.ts` 自身が dev mirror を出すために 1 箇所だけ `console.*` を使う（テストの spy 慣行・Electrobun launcher 捕捉のため）。
- **Electrobun launcher 由来の起動メッセージ** は logger を介さない（プロセス境界を超えるため）。これは例外として stdout の native 出力を許容する。

## 出力先

- **ファイル**: `~/Library/Logs/slAIdo/main.log`（macOS）
- **stdout**: dev ビルド (`channel: dev`) のときのみミラー出力。production では出さない。
- **テスト**: `process.env.SLAIDO_LOG_DIR` で出力ディレクトリを上書き可能（デフォルトは `~/Library/Logs/slAIdo/`）。

ログファイルのローテートは現時点で行わない。サイズ管理が必要になったら logrotate / `tail -n` 運用または別途ローテータを追加する。

## メインビュー（WebView）側

`src/mainview/` 配下では本ポリシーの直接適用外。`__SLAIDO_RECEIVE__` で受け取った構造化メッセージをデバッグする目的に限り `console.log` を許容する。本格的なログは Bun 側に host-message 経由で寄せる。

## opencode セッションログ拡張

`src/bun/opencode/transcript.ts` の `TranscriptLogger` 経由で、opencode SDK の `client.app.log` を叩き opencode 側のセッションログに slaido 由来のメタデータを inject する。**main.log とは独立したセカンダリ経路** であり、両方を残す two-track 設計を採る。

### 出力先

- **ファイル**: `~/.local/share/opencode/log/<timestamp>.log`（opencode サーバが管理・ローテート）
- main.log と異なり、slaido 側で出力先を制御できない。複数セッション分のログが時系列に並ぶ。
- main.log の `transcript_log_failed` warn が出ていたら `/log` POST 経路の劣化（opencode サーバ未起動 / HTTP 400）を疑う。

### 設計

| 項目 | 値 |
|---|---|
| service フィールド | `"slaido"` 固定（grep one-liner 用） |
| level | `"info"` / `"warn"` / `"error"` / `"debug"`（opencode SDK の許容値） |
| message | `slaido_*` の snake_case イベント名（main.log と同じ命名規約） |
| 呼び出し方式 | fire-and-forget（`void` で投げる）。失敗しても呼び出し側に throw しない |
| client 未初期化時 | drop し、`transcript_log_failed` warn を main.log に **1 度だけ** 出す |

### 主要イベント（埋め込みポイント）

- `slaido_started` — bootstrap 直後（client 未初期化のため drop + warn 1 回が想定動作）
- `slaido_opencode_ready` — chat-bridge.init() 成功後（以降のイベントは opencode log に届く）
- `slaido_opencode_failed` — `opencode_start_failed` / `chat_bridge_init_failed`
- `slaido_generate_start` / `slaido_generate_end` / `slaido_generate_failed`
- `slaido_refine_start` / `slaido_refine_end` / `slaido_refine_failed`
- `slaido_export_pdf_start` / `_end` / `_failed` / `_canceled`
- `slaido_export_html_zip_start` / `_end` / `_failed` / `_canceled`
- `slaido_host_message_failed` — host-message ハンドラの catch

### `extra` の許容項目

- 識別: `slaidoVersion` / `buildSha` / `slaidoProcessId` / `slaidoChannel`
- セッション: `projectId` / `sessionId` / `slidesEntry` / `projectTitle`
- 入力: `seedLen` + `seedHash`（seed 全文） / `msgLen` + `msgHash`（chat 入力） — **本文は載せない**
- 推論: `model` / `phase`（`start` / `end` / `error` / `canceled` / `ready`）
- 計測: `durationMs` / `kind`（`pdf` / `html-zip`）
- エラー: `errMessage`（Error.message） / `errStack`（先頭 800 文字 truncate）

### 禁止項目

- **seed 本文・chat 入力本文**: hash + length のみ出す
- **API キー / OAuth トークン**: そもそも extra に積まない
- **ファイル本文・HTML 本文**: 出力ファイルパスのみ

### `seedHash` / `msgHash` 仕様

- `node:crypto.createHash("sha256")` で全文を hash 化し、hex の先頭 12 文字のみを extra に積む（`hashSeed` 関数）。
- 衝突確率 `< 2^-48`、grep 可読性、本文非漏洩のバランス。

### 運用 grep ワンライナー

```
# 直近 1 セッションの slaido イベントを時系列で見る
ls -t ~/.local/share/opencode/log/*.log | head -1 | xargs grep service=slaido

# 同一プロジェクトの推論ステップを横断 grep
grep "service=slaido" ~/.local/share/opencode/log/*.log | grep "projectId=<id>"

# /log POST 経路の劣化を疑う
grep transcript_log_failed ~/Library/Logs/slAIdo/main.log
```
