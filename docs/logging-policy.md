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
