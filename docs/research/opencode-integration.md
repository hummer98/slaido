# opencode Headless 統合 — 実現性調査

作成日: 2026-04-29
担当: Researcher (task-006)
対象: slAIdo (Electrobun + reveal.js + opencode + OpenRouter)
調査範囲: 一次情報 (opencode 公式 docs / GitHub / OpenRouter 公式 docs / Apple 公式 docs)

---

## サマリ

| # | 項目 | 結論 |
|---|---|---|
| 1 | opencode の headless / programmatic 統合手段 | **できる**。`opencode serve` (HTTP+SSE) / `opencode run --format json` / `opencode acp` (stdio nd-JSON) / `@opencode-ai/sdk` (npm) の 4 経路が公式提供されており、TUI 起動は不要 |
| 2 | チャット往復の入出力 | **できる**。`session.prompt({ parts })` で送信、`event.subscribe()` 経由 SSE で `message.updated` / `message.part.updated` / `step-start` / `step-finish` / `permission.asked` 等を構造化イベントとして取得可能 |
| 3 | 生成成果物 (reveal.js HTML) の受け渡し | **条件付きでできる**。opencode はワーキングディレクトリ上のファイルを直接 edit する設計。テンプレを cwd に置き、ファイル変更 + `message.part.updated` を併用してプレビュー反映する。**JSON Schema 構造化出力** も可 (`format: { type: "json_schema" }`) |
| 4 | OpenRouter 連携 | **できる**。opencode は OpenRouter をネイティブサポート。`opencode.json` の `provider.openrouter` で設定、API キーは `auth.set()` または環境変数経由で渡せる。多くのモデルがデフォルトで pre-load 済み |
| 5 | BYOK (API キー保存) | **条件付きでできる**。opencode の `~/.local/share/opencode/auth.json` はプレーン JSON のため、Electrobun 側で **macOS Keychain を併用**するのが妥当。実行時に `{env:OPENROUTER_API_KEY}` で注入する方式を推奨 |
| 6 | ライセンス・配布 | **MIT — 組込み・再配布 OK**。macOS バイナリは ~33MB (zip)。**Homebrew Cask は容易**、**Mac App Store は要追加検証 (リスク高) — P2 = MVP リリース後着手** (根拠は §015 に集約) |
| 7 | 代替・撤退ライン | **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`, Anthropic 公式) が一次代替。OpenRouter 直叩き + 自前ツールループは MVP の工数を大幅に増やすため推奨しない |

### GO / NOGO 総合判断

**GO（条件付き、Homebrew Cask 配布を主軸とする前提で）**

- 統合経路 (1)、チャット I/O (2)、ファイル編集ループ (3)、OpenRouter (4) はすべて公式に提供されており、技術的なブロッカーは無い
- ライセンス (6) も MIT で問題なし
- 唯一のリスクは **Mac App Store 配布**。**MVP は Homebrew Cask 配布**に倒し、MAS は **P2 (MVP リリース後着手)** とする (理由・着手順は §015 タスクに集約)
- BYOK (5) は Keychain 併用で UX とセキュリティを両立できる

---

## 1. opencode の headless / programmatic 統合手段

### 1.1 提供されている 4 経路

公式 docs と CLI リファレンスから、TUI を起動せずに opencode を駆動する手段が **4 つ** 確認できた。

| 経路 | 起動方法 | 通信方式 | 主用途 |
|---|---|---|---|
| **HTTP API + SSE** | `opencode serve [--port 4096]` | REST + Server-Sent Events | アプリから常駐サーバとして利用 |
| **CLI 単発実行** | `opencode run --format json "..."` | stdout に nd-JSON イベント | スクリプト / ワンショット呼び出し |
| **ACP (Agent Client Protocol)** | `opencode acp` | stdin/stdout 上の nd-JSON (JSON-RPC) | IDE / クライアントからのサブプロセス統合 |
| **TypeScript SDK** | `npm i @opencode-ai/sdk` | 内部で HTTP+SSE をラップ | アプリから型付きで呼び出す |

> "opencode serve … Start a headless OpenCode server for API access" — [opencode CLI docs](https://opencode.ai/docs/cli/)

> "opencode run … Run opencode in non-interactive mode by passing a prompt directly. … `--format default (formatted) or json (raw JSON events)`" — [opencode CLI docs](https://opencode.ai/docs/cli/)

> "opencode acp … This command starts an ACP server that communicates via stdin/stdout using nd-JSON." — [opencode ACP docs](https://opencode.ai/docs/acp/)

> "The opencode JS/TS SDK provides a type-safe client for interacting with the server." — [opencode SDK docs](https://opencode.ai/docs/sdk/)

### 1.2 推奨経路

slAIdo の構成では **`opencode serve` + `@opencode-ai/sdk`** が最適。理由:

- Electrobun のメインプロセス (Bun) から TypeScript SDK で型付き呼び出しできる
- セッションを保持したまま複数往復できる (run コマンドは毎回再起動)
- SSE で reasoning / tool use / message part をリアルタイム取得できる
- ACP は IDE 向けに最適化されており、独自 UI を持つ slAIdo には冗長

```typescript
// ソース: https://opencode.ai/docs/sdk/
import { createOpencode } from "@opencode-ai/sdk"
const { client } = await createOpencode()
const session = await client.session.create({ body: { title: "slide-gen" } })
```

`createOpencode()` は内部で opencode サーバを spawn し、`baseUrl` を返す。Electrobun のメインプロセス (Bun) から呼べる。

### 1.3 子プロセス制御

- `createOpencode()` は `signal: AbortSignal` を受け付けるため、AbortController で停止可能
- 既存サーバに繋ぐ場合は `createOpencodeClient({ baseUrl })` で OK
- `OPENCODE_SERVER_PASSWORD` で HTTP Basic 認証を強制できるため、ローカルでも localhost 以外に晒さない設計が可能 ([source](https://opencode.ai/docs/server/))
- `opencode run --attach` で既存 `serve` インスタンスに接続できるため MCP cold-boot を回避できる

### 1.4 バイナリ配布形態

opencode は単一バイナリ (Bun コンパイル済み)。Node / Bun ランタイム不要で動作する。以下のバージョン番号・サイズはいずれも**執筆時点 = 2026-04-29** の値であり、実装時には最新リリースを再確認すること。
- macOS arm64: `opencode-darwin-arm64.zip` (33.5 MB)
- macOS x64: `opencode-darwin-x64.zip` (35.6 MB)
- 署名済 .app: `opencode-desktop-darwin-aarch64.app.tar.gz` (47.8 MB)

> [opencode v1.14.29 リリース](https://github.com/sst/opencode/releases) (2026-04-28)

---

## 2. チャット往復の入出力

### 2.1 入力: `session.prompt`

```typescript
// ソース: https://opencode.ai/docs/sdk/
await client.session.prompt({
  path: { id: session.id },
  body: {
    parts: [
      { type: "text", text: "シードドキュメントを反映してスライドを生成して" },
      { type: "file", /* file reference */ }
    ],
    model: { providerID: "openrouter", modelID: "anthropic/claude-sonnet-4" },
    format: { type: "json_schema", schema: { /* ... */ } }, // 任意
    noReply: false,
  }
})
```

**Part の型** (公式 SDK 型定義より):
- `text` — テキストチャンク
- `file` — ファイル参照
- `tool` — tool 呼び出し / 結果
- `reasoning` — モデルの推論

ユーザー入力 (自由テキスト + 添付テキスト) は `parts` 配列で複数添付できる。

### 2.2 ストリーミング応答: `event.subscribe`

```typescript
// ソース: https://opencode.ai/docs/sdk/
const events = await client.event.subscribe()
for await (const event of events.stream) {
  console.log(event.type, event.properties)
}
```

REST 等価エンドポイント:

> "`GET /event` — Server-sent events stream. First event is `server.connected`, then bus events" — [opencode Server docs](https://opencode.ai/docs/server/)

### 2.3 取得できるイベント種別

`opencode run --format json` の実装ソースから確認できたイベント (SSE と同形式):

| イベント | 用途 |
|---|---|
| `message.updated` | アシスタントメッセージ全体の更新 |
| `message.part.updated` | 個別パート (テキスト/ツール/推論) 更新 |
| `step-start` | エージェントステップ開始 |
| `step-finish` | エージェントステップ完了 |
| `session.error` | エラー |
| `session.status` | セッション状態変更 (idle / running 等) |
| `permission.asked` | パーミッション要求 (file edit / bash 等) |

slAIdo の左ペイン (チャット UI) には:
- `message.part.updated` の `type=text` / `type=reasoning` をストリーミング表示
- `permission.asked` を「実行してよいですか?」UI に変換 (一般ユーザー向けは `permission: "allow"` 既定でも可)
- `tool` パートは「ファイルを編集中…」のステータス行に集約 (生 JSON は出さない)

を流す。生 tool 呼び出しの JSON は一般ユーザーには見せない方針。

### 2.4 構造化 JSON 出力

`session.prompt` に `format: { type: "json_schema", schema }` を渡すと、モデルが `StructuredOutput` ツールで JSON を返す。reveal.js のスライド構造を JSON Schema で定義しておけば、HTML を介さずに直接構造データを受け取れる。MVP では「ファイル編集ループ」を主、構造化出力を保険として保持する。

---

## 3. 生成成果物 (reveal.js HTML) の受け渡し

### 3.1 ファイルシステム経由が標準

opencode は **ワーキングディレクトリのファイルを直接編集する設計**。`createOpencode({ config: ... })` または `serve --cwd` で cwd を slAIdo のプロジェクト保管庫 (例: `~/Library/Application Support/slAIdo/projects/<id>/`) に向ける。

- "GET /file/content?path=&lt;p&gt; — Read a file returning FileContent" — [opencode Server docs](https://opencode.ai/docs/server/)
- `edit` permission を `"allow"` にするか、permission.asked で UI 確認 ([source](https://opencode.ai/docs/permissions/))

### 3.2 推奨プロジェクトレイアウト

```
~/Library/Application Support/slAIdo/projects/<projectId>/
├── slides/
│   ├── index.html          # reveal.js テンプレ (slAIdo 同梱を初回コピー)
│   └── slides/             # <section> 単位のパーシャル (任意)
├── seed/
│   └── input.md            # ユーザーが貼り付けたシード
├── opencode.json           # provider / agent / permission 設定
└── AGENTS.md               # slAIdo のスライド生成プロンプト規約
```

### 3.3 反映ループ

1. ユーザーが「3 枚目を直して」と入力
2. slAIdo が `client.session.prompt` で送信
3. opencode が `slides/index.html` を read → edit
4. slAIdo は **次の 2 経路** でプレビュー反映:
   - **a.** `event.subscribe` の `message.part.updated` (type=tool, tool=edit) を検知し、対象ファイルを再読込
   - **b.** `chokidar` (Bun) で `slides/` ディレクトリ監視 (saver イベントとして冗長確保)
5. iframe (右ペイン) に最新 HTML を再ロード

「毎回どのファイルを読み直すか」は **(a) の tool イベントでパスを取得する** のが正解。`AGENTS.md` にも「reveal.js 出力先は必ず `slides/index.html`」と書く。

### 3.4 reveal.js テンプレートの管理

- 初回プロジェクト作成時に slAIdo の bundle 内蔵テンプレを cwd 配下にコピー
- `views://` (Electrobun の bundled assets スキーマ) でアプリリソースとして同梱可能 ([Electrobun docs](https://blackboard.sh/electrobun/docs))
- ユーザーがテーマを選択した場合は `assets/css/theme/*.css` を差し替え

---

## 4. OpenRouter 連携

### 4.1 ネイティブサポート

opencode は OpenRouter を 75+ サポートプロバイダの 1 つとして組込み済み。

> "Providers… OpenAI、Anthropic、Google Vertex AI、Azure OpenAI、AWS Bedrock、Groq、DeepSeek、xAI、Ollama、**OpenRouter**、Together AI など" — [opencode Providers docs](https://opencode.ai/docs/providers/)

### 4.2 設定方法

#### 対話的 (TUI) — 一般ユーザーには使わせない

```
/connect → OpenRouter を選択 → API key 入力
→ ~/.local/share/opencode/auth.json に保存
```

#### プログラム経由 (slAIdo が裏でやる)

```typescript
// ソース: https://opencode.ai/docs/sdk/
await client.auth.set({
  path: { id: "openrouter" },
  body: { type: "api", key: openRouterApiKey }
})
```

または `opencode.json` で環境変数経由:

```jsonc
// ソース: https://opencode.ai/docs/config/
{
  "$schema": "https://opencode.ai/config.json",
  "model": "openrouter/anthropic/claude-sonnet-4",
  "provider": {
    "openrouter": {
      "options": { "apiKey": "{env:OPENROUTER_API_KEY}" },
      "models": {
        "anthropic/claude-sonnet-4": {},
        "openai/gpt-5.2": {},
        "google/gemini-2.5-pro": {}
      }
    }
  },
  "permission": {
    "edit": "allow",
    "bash": "ask",
    "webfetch": "deny"
  }
}
```

### 4.3 モデル切替 UX

- **デフォルトモデル** は `opencode.json` の `model` で固定 (推奨: `openrouter/anthropic/claude-sonnet-4`)
- ユーザーが切替えたければ slAIdo 側でモデル選択 UI を持ち、`session.prompt({ body: { model: { providerID, modelID } } })` で都度指定
- MVP は **デフォルトのみ**、設定 UI は後続タスク

### 4.4 推奨モデル候補

OpenRouter 上で MVP 品質を満たすモデル ([OpenRouter quickstart](https://openrouter.ai/docs/quickstart)):

| モデル ID | 用途 | コスト感 |
|---|---|---|
| `anthropic/claude-sonnet-4` | デフォルト (バランス型) | 中 |
| `openai/gpt-5.2` | 代替 | 中〜高 |
| `google/gemini-2.5-pro` | 長文コンテキスト | 中 |
| `anthropic/claude-haiku-4-5` | small_model (軽量タスク) | 低 |

> ※ OpenRouter のモデルカタログは流動的のため、本表および本文中の `openai/gpt-5.2` / `anthropic/claude-haiku-4-5` / `anthropic/claude-sonnet-4` 等は**執筆時点のサンプル ID** にすぎない。実装時には [OpenRouter モデル一覧](https://openrouter.ai/models) から最新カタログを参照して選定すること。

---

## 5. BYOK (API キー保存)

### 5.1 opencode 単体での保存

`/connect` で入力された API キーは:

> "API キーは `~/.local/share/opencode/auth.json` に保存されます" — [opencode Providers docs](https://opencode.ai/docs/providers/)

このファイルは **プレーン JSON** (公式 docs に暗号化の記述なし)。一般ユーザー配布アプリのキー保管としては保護が薄い。

### 5.2 推奨パターン: macOS Keychain 併用

- **Electrobun 側で macOS Keychain を Source of Truth として保持**
- 起動時に slAIdo が Keychain から読み出し、子プロセス環境変数 `OPENROUTER_API_KEY` として opencode に渡す
- `opencode.json` に `"apiKey": "{env:OPENROUTER_API_KEY}"` と書く
- auth.json は使わない (opencode 設定上は環境変数のみで動く)

#### 利点

- ユーザーがアプリをアンインストールしても Keychain と auth.json の整合性問題が起きない
- MAS sandbox 配布時、Keychain アクセスは entitlements (`keychain-access-groups`) で許可可能
- 鍵暗号化は OS が担保 (FileVault + Keychain)

#### 注意点

- opencode が一部内部処理で auth.json を期待する経路がある場合に備え、`auth.set()` SDK 呼び出しで auth.json も同期しておくと安全 (要検証)

### 5.3 初回起動時の UX 案

1. 初回起動 → 「OpenRouter API キーを入力してください」モーダル
2. キーを入力 → Keychain に保存
3. 任意: 「OpenRouter にサインアップする」ボタン (`https://openrouter.ai/settings/keys` を外部ブラウザで開く)
4. 検証用に `client.session.prompt` を 1 回叩いて成功した場合のみ完了

---

## 6. ライセンス・配布

### 6.1 ライセンス

opencode は **MIT License** (`github.com/sst/opencode/LICENSE`)。

> "use, copy, modify, merge, publish, distribute, sublicense, and/or sell" を許可 — [opencode LICENSE](https://github.com/sst/opencode/blob/master/LICENSE)

組込み・再配布共に問題なし。配布物にはライセンス全文と著作権表記を含めれば足りる。

### 6.2 Homebrew Cask 配布

**容易**。次のいずれかが選択肢:

- **Cask 内同梱**: slAIdo の .app bundle 内に opencode バイナリを `Contents/Resources/bin/opencode` として置き、Bun.spawn で呼ぶ
- **依存指定**: Cask Formula で `depends_on cask: "opencode"` を書き、ユーザーに別途インストールさせる (UX が劣る)

→ MVP は **同梱**を推奨。ライセンスもクリア。

### 6.3 Mac App Store (MAS) 配布

**条件付き、ただし要追加検証**。

#### Apple 公式の制約

> "If you embed an executable within a sandboxed app it must have the `com.apple.security.app-sandbox` and `com.apple.security.inherit` entitlements, and only those entitlements." — [Embedding a command-line tool in a sandboxed app | Apple Developer](https://developer.apple.com/documentation/xcode/embedding-a-helper-tool-in-a-sandboxed-app)

すなわち:
- バイナリ自体に `com.apple.security.app-sandbox` + `com.apple.security.inherit` を付与し、再署名が必要
- Info.plist を `CREATE_INFOPLIST_SECTION_IN_BINARY` で埋め込み
- 「Copy Files / Embed Helper Tools」フェーズで `Contents/MacOS/` 等に配置

#### opencode 固有の懸念

- opencode は **任意のファイル編集 / bash 実行 / ネット fetch** を行う。MAS sandbox では:
  - ユーザー選択ディレクトリ外の I/O は不可 (NSOpenPanel 経由なら可)
  - bash や exec の自由実行は不可
  - ネットワークアクセスは `com.apple.security.network.client` が必要

→ slAIdo がプロジェクトディレクトリを 1 つ「ドキュメントスコープ」として選ばせるパターンなら回避可能だが、opencode のすべての tool が sandbox を尊重するかは未検証。**スパイクが必要**。

#### 結論

- **MVP では Homebrew Cask を主軸**にする
- MAS は「将来オプション」として設計上は閉じ込めできる作りにしておく (Keychain / プロジェクトディレクトリのドキュメントスコープ化)
- **着手時期と P2 化の根拠は「後続実装タスクの分解案 §015」に集約**

### 6.4 Electrobun への同梱方式

Electrobun は **Bundled Assets** (views:// schema) でアプリリソースを埋め込める ([docs](https://blackboard.sh/electrobun/docs))。CEF (Chromium Embedded Framework) を含めても 14MB という軽量設計。

- 推奨: Build Configuration の Copy Files フェーズで opencode バイナリを `resources/bin/opencode-darwin-arm64` として置く
- 起動時に `app.getResourcePath('bin/opencode-darwin-arm64')` で絶対パスを取得 → `Bun.spawn`
- 配布前に opencode バイナリを **再署名** + (MAS なら) entitlements 付与

---

## 7. 代替・撤退ライン

### 7.1 一次代替: Claude Agent SDK

> "Claude Agent SDK enables you to programmatically build AI agents with Claude Code's capabilities" — [@anthropic-ai/claude-agent-sdk on npm](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk)

- TypeScript / Python 公式 SDK (Anthropic 社製)
- Claude Code と同じ tool-use ループ / context management
- ファイル編集 / bash / web search 等の組込みツール
- **ただし OpenRouter 経由ではなく Anthropic 直叩き** (Bedrock / Vertex は対応)

**採用ケース**: opencode 同梱に MAS で不可避な障害が発覚し、かつ「OpenRouter 一本化」を諦める判断をした場合。Claude 単一プロバイダで MVP を出す撤退ライン。

### 7.2 二次代替: OpenRouter 直叩き + 自前ループ

- OpenRouter は OpenAI 互換 (`POST /api/v1/chat/completions`) — [OpenRouter docs](https://openrouter.ai/docs/quickstart)
- tool use / file edit / sandbox 制御を **すべて自前実装** が必要
- MVP の工数が 3〜5 倍に膨らむため非推奨

**採用ケース**: opencode が成立せず、Claude Agent SDK もライセンス / 価格で不可となった極端なケースのみ。

### 7.3 NOGO ライン (どれかが NG なら方針再考)

| 項目 | 状態 | NG の場合の対応 |
|---|---|---|
| headless 経路 (TUI 不要) | OK (4 経路あり) | — |
| ストリーミング | OK (SSE + nd-JSON) | — |
| ライセンス | OK (MIT) | Claude Agent SDK へ撤退 |
| OpenRouter サポート | OK (ネイティブ) | — |
| BYOK 制御 | OK (環境変数 + Keychain) | — |
| **MAS 同梱** | **要追加検証 — リスク高** | **Homebrew Cask に倒す** (MVP では既定。MAS は P2 = MVP リリース後着手 — §015 参照) |
| ファイル編集ループの安定性 | 要スパイクで検証 | 構造化 JSON 出力 (`format: json_schema`) に切替 |

---

## 推奨統合形態

### 採るべき方式

**`opencode serve` の常駐 + `@opencode-ai/sdk` 経由の HTTP+SSE 通信**

### 理由

1. Electrobun (Bun) のメインプロセスから型付き SDK で扱える
2. セッションを保持したまま複数往復できる (run コマンドのコールドスタートを回避)
3. SSE で reasoning / tool use を **構造的** にチャット UI へ流せる
4. ACP は IDE 向けで冗長、自前 UI には HTTP/SDK の方が素直
5. opencode が更新されても SDK バージョンを上げるだけで追従できる

### 想定アーキテクチャ

```
┌─────────────────────────────────────────────────────────────┐
│ slAIdo.app (Electrobun, ~14MB + opencode ~33MB = ~50MB)    │
│                                                             │
│  ┌──── Main Process (Bun) ──────────────────────────────┐   │
│  │                                                       │   │
│  │  ┌─ ChatBridge ───────────────┐                       │   │
│  │  │  @opencode-ai/sdk          │                       │   │
│  │  │  createOpencode()          │──spawn──┐             │   │
│  │  │  session.prompt()          │         │             │   │
│  │  │  event.subscribe() (SSE)   │         │             │   │
│  │  └────────────────────────────┘         ▼             │   │
│  │                                  ┌─────────────────┐  │   │
│  │  ┌─ KeychainAdapter ──────────┐  │ opencode bin    │  │   │
│  │  │  read/write OPENROUTER_KEY │  │ (subprocess)    │  │   │
│  │  └────────────────────────────┘  │  - HTTP :4096   │  │   │
│  │                                  │  - SSE /event   │  │   │
│  │  ┌─ ProjectStore ─────────────┐  │  - file edit    │  │   │
│  │  │  ~/Library/.../projects/<id>│ └────────┬────────┘  │   │
│  │  │   ├─ slides/index.html ◄───┼──────────┘           │   │
│  │  │   ├─ seed/input.md         │                       │   │
│  │  │   ├─ opencode.json         │                       │   │
│  │  │   └─ AGENTS.md             │                       │   │
│  │  └────────────────────────────┘                       │   │
│  └───────────────────────────────────────────────────────┘   │
│                       ▲                  ▲                   │
│                       │ host-message     │ executeJavascript │
│                       ▼                  ▼                   │
│  ┌──── BrowserWindow (WKWebView) ───────────────────────┐   │
│  │                                                       │   │
│  │  ┌─ 左ペイン: Chat UI ─┐  ┌─ 右ペイン: Preview ────┐  │   │
│  │  │  - 入力欄           │  │  iframe srcdoc =       │  │   │
│  │  │  - 履歴表示         │  │   slides/index.html    │  │   │
│  │  │  - reasoning 折畳    │  │  (chokidar で再読込)   │  │   │
│  │  │  - permission UI    │  │                        │  │   │
│  │  └─────────────────────┘  └────────────────────────┘  │   │
│  └───────────────────────────────────────────────────────┘   │
│                                                             │
└─────────────────────────────────────────────────────────────┘
                       │
                       │ HTTPS
                       ▼
                ┌──────────────┐
                │ OpenRouter   │
                │ /chat/comp.. │
                └──────────────┘
```

### 通信フロー (1 往復)

```
ユーザー入力 (左ペイン)
   │
   ├─→ [Bun] client.session.prompt({ parts: [{type:"text", text}] })
   │
   │   ┌─ HTTP POST /session/:id/prompt ─→ opencode
   │   │
   │   │  opencode が edit tool で slides/index.html 編集
   │   │
   │   └─ SSE /event:
   │      - message.part.updated (type=reasoning) → 左ペインに折畳表示
   │      - message.part.updated (type=tool, tool=edit, path=slides/index.html) → 右ペイン更新トリガ
   │      - permission.asked → 一般ユーザーは既定 allow / 危険操作のみ確認 UI
   │      - message.updated / step-finish → 完了
   │
   ├─→ [Bun] chokidar が slides/index.html 変更を検知
   │
   └─→ [WebView] executeJavascript で iframe srcdoc 更新
```

---

## 後続実装タスクの分解案

Master が draft 起票できる粒度で以下に分解する。

### 008. opencode バイナリ同梱 + spawn 基盤
- **目的**: アプリ起動時に opencode サーバを安全に spawn / shutdown できる基盤
- **インプット**: opencode-darwin-arm64 / x64 バイナリ、Electrobun build config
- **アウトプット**: `Contents/Resources/bin/opencode-*` に同梱、`OpencodeServerManager` クラス (start/stop/health)
- **依存**: なし (本タスクの結論)

### 009. @opencode-ai/sdk 統合 + ChatBridge
- **目的**: SDK で session 管理 + SSE 受信を行うラッパ
- **インプット**: 008 の OpencodeServerManager、@opencode-ai/sdk
- **アウトプット**: `ChatBridge` (sendMessage, onEvent, abort) — 上位 UI と疎結合
- **依存**: 008

### 010. OpenRouter プロバイダ設定 + Keychain BYOK
- **目的**: Keychain → 環境変数 → opencode.json `{env:OPENROUTER_API_KEY}` の経路を確立
- **インプット**: macOS Keychain API、opencode.json テンプレ
- **アウトプット**: `KeychainAdapter`、初回起動時のキー入力モーダル、ヘルスチェック
- **依存**: 008
- **注**: 既存 task 001 (llm-provider-openrouter) / 002 (byok-keychain) と統合検討

### 011. プロジェクトストア + reveal.js テンプレ展開
- **目的**: `~/Library/Application Support/slAIdo/projects/<id>/` の作成・テンプレ展開
- **インプット**: reveal.js テンプレ (slAIdo bundle 内の views://)
- **アウトプット**: `ProjectStore` (create/load/delete)、初回 `slides/index.html` 配置
- **依存**: なし

### 012. プレビュー反映ループ (chokidar + tool イベント)
- **目的**: `slides/index.html` の変更を iframe に反映
- **インプット**: 009 の `onEvent`、chokidar、Electrobun の executeJavascript
- **アウトプット**: `PreviewSync` (右ペイン更新)
- **依存**: 009, 011

### 013. チャット UI イベントマッピング
- **目的**: SSE イベントを左ペイン UI 向けにマップ (reasoning 折畳、tool ステータス、permission UI)
- **インプット**: 009 の `onEvent`
- **アウトプット**: 左ペインの React/Vanilla コンポーネント
- **依存**: 009 と既存 task 003 (UI)

### 014. AGENTS.md / opencode.json テンプレ整備
- **目的**: slAIdo 用システムプロンプト + プロジェクト規約を AGENTS.md に確立
- **インプット**: seed.md、reveal.js のスライド命名規約 (`<section>` 単位)
- **アウトプット**: `AGENTS.md`、`opencode.json` (model, permission, provider 設定)
- **依存**: 011

### 014.5. スライドエクスポート (PDF / PPTX / HTML 配布パッケージ)
- **目的**: 完成スライドを PDF または PPTX 形式で書き出し、ユーザーが共有・配布できるようにする
- **インプット**: 完成した `slides/index.html` (reveal.js) / `slides.md` (Markdown 経路を採る場合)
- **アウトプット**:
  - **PDF**: reveal.js 公式の print-to-pdf 経路 (`?print-pdf` クエリ + Chromium ヘッドレス印刷) または [decktape](https://github.com/astefanutti/decktape) を同梱・spawn する経路
  - **PPTX**: Markdown → PPTX 変換 (例: pandoc / marp 経由) または reveal.js HTML をスライド単位で画像化して PPTX に貼り付ける経路
  - **HTML 配布パッケージ**: `slides/` ディレクトリ一式 + reveal.js ランタイムを zip にまとめた配布物 (オフライン再生可能)
- **依存**: 010〜014 の生成・編集ループが安定したあと (主に 011 / 012 / 014)
- **優先度**: P1 (MVP に含める)
- **スコープ判断**:
  - **PDF と HTML zip は MVP 必須**(reveal.js のままで提供できるため工数低)
  - **PPTX は MVP 内含めるか後送りかを 014.5 着手時に再判断** (Markdown 経由の品質次第)
- **注**: 「保存」操作 (=プロジェクト永続化) は 011 の `ProjectStore` で扱う。本タスクは「外部共有用書き出し」専用

### 015. MAS sandbox スパイク (将来)
- **目的**: opencode を sandbox + entitlements で実行できるか検証
- **インプット**: 008 の同梱物、Apple Developer Program アカウント
- **アウトプット**: スパイクレポート (GO / NOGO 結論)
- **依存**: 008
- **優先度**: **P2 (MVP リリース後着手)**
- **P2 とした根拠** (本レポート内の MAS 関連記述はすべてここに集約。他セクションは本項を参照):
  1. MVP 配布は Homebrew Cask を主軸とする方針が確定済 (本文 6.2 / 6.3)。MAS は「将来オプション」であり MVP のクリティカルパスに乗らない
  2. opencode は任意の bash / file edit / webfetch を行うため、MAS sandbox + 限定 entitlements 下で機能維持できるかは**本タスクのスパイクで初めて判明**する。検証結果次第で同梱構成・Keychain 連携・プロジェクトスコープ設計に手戻りが入りうる
  3. ゆえに「MVP リリース → ユーザーフィードバック収集 → MAS 検証着手」の順が最も手戻りリスクが少なく合理的

### 016. Homebrew Cask 配布パイプライン
- **目的**: GitHub Releases → Homebrew Cask 投稿
- **インプット**: build artifact (.app)、署名済 .dmg
- **アウトプット**: Cask Formula PR
- **依存**: 008, 010

---

## 不明点・追加調査が必要な事項

1. **MAS sandbox 下での opencode の動作**
   - opencode のすべての tool (edit / bash / webfetch / mcp) が sandbox + 限定 entitlements で動くかは未検証
   - とくに bash tool は MAS では実質不可になる可能性大
   - **対応**: タスク 015 のスパイクで決着

2. **`auth.set()` API での auth.json 同期可否**
   - Keychain → 環境変数注入で動くと推測しているが、opencode 内部で auth.json 必須の処理がないかは要動作検証
   - **対応**: 010 実装初期に動作確認

3. **`message.part.updated` の確実性**
   - tool イベントの順序保証 / 抜け漏れの可能性 (chokidar 併用で冗長確保する設計だが、片方で十分かは要計測)
   - **対応**: 012 実装中に観測

4. **OpenRouter モデルごとの slide 生成品質**
   - claude-sonnet-4 / gpt-5.2 / gemini-2.5-pro でアウトプット品質と速度の比較が必要
   - **対応**: MVP のスパイク時にベンチ

5. **opencode のアップデート戦略**
   - 同梱バージョンのアップデートを slAIdo のリリースに合わせるか、独立配信か
   - **対応**: 016 と合わせて方針決定

6. **大量同時ファイル編集時の挙動**
   - 「全 20 枚を作り直して」のような大量編集時の SSE スループットと UI 描画
   - **対応**: 012 / 013 でストレステスト

7. **opencode の `format: json_schema` の OpenRouter 経由での挙動**
   - Claude / GPT-5.2 / Gemini で structured output 互換性に差がある
   - **対応**: 014 / モデル選定時に検証

---

## 参考文献

### opencode (一次情報)

- [opencode GitHub Repository](https://github.com/sst/opencode) (MIT License)
- [opencode 公式サイト](https://opencode.ai)
- [opencode Documentation Index](https://opencode.ai/docs)
- [opencode SDK Reference](https://opencode.ai/docs/sdk/) — `@opencode-ai/sdk` の TypeScript リファレンス
- [opencode CLI Reference](https://opencode.ai/docs/cli/) — `serve` / `run` / `acp` / `agent` / `auth` 等
- [opencode Server API](https://opencode.ai/docs/server/) — REST + SSE エンドポイント、OpenAPI 3.1 spec
- [opencode ACP Support](https://opencode.ai/docs/acp/) — stdio nd-JSON プロトコル
- [opencode Configuration](https://opencode.ai/docs/config/) — opencode.json 形式、保存場所、provider 設定
- [opencode Providers](https://opencode.ai/docs/providers/) — 75+ プロバイダ、OpenRouter 設定
- [opencode Permissions](https://opencode.ai/docs/permissions/) — read/edit/bash/webfetch 等の権限制御
- [opencode Agents](https://opencode.ai/docs/agents/) — エージェント定義 / AGENTS.md
- [opencode Zen](https://opencode.ai/docs/zen/) — opencode 公式 SaaS (本タスクでは不採用)
- [opencode v1.14.29 Release (2026-04-28)](https://github.com/sst/opencode/releases) — macOS バイナリサイズ確認
- [opencode LICENSE (MIT)](https://github.com/sst/opencode/blob/master/LICENSE)
- [@opencode-ai/sdk on npm](https://www.npmjs.com/package/@opencode-ai/sdk)

### OpenRouter (一次情報)

- [OpenRouter Quickstart](https://openrouter.ai/docs/quickstart) — 認証 / エンドポイント / OpenAI 互換性
- [OpenRouter Models](https://openrouter.ai/models) — モデルカタログ (執筆時点のサンプル ID 検証用)
- [OpenRouter API Keys Dashboard](https://openrouter.ai/settings/keys)

### Agent Client Protocol

- [Agent Client Protocol 公式サイト](https://agentclientprotocol.com/)
- [Zed - Agent Client Protocol](https://zed.dev/acp)

### 代替手段

- [@anthropic-ai/claude-agent-sdk on npm](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk)
- [anthropics/claude-agent-sdk-typescript](https://github.com/anthropics/claude-agent-sdk-typescript)
- [Claude Agent SDK Overview](https://code.claude.com/docs/en/agent-sdk/overview)

### Electrobun

- [Electrobun 公式サイト (blackboard.sh/electrobun)](https://blackboard.sh/electrobun/)
- [Electrobun Documentation](https://blackboard.sh/electrobun/docs)

### スライドエクスポート (014.5 タスク向け)

- [reveal.js — PDF Export](https://revealjs.com/pdf-export/) — `?print-pdf` クエリ + Chromium ヘッドレス印刷
- [astefanutti/decktape](https://github.com/astefanutti/decktape) — reveal.js 等のスライドを PDF 化する CLI

### Apple (MAS sandbox)

- [Embedding a command-line tool in a sandboxed app | Apple Developer](https://developer.apple.com/documentation/xcode/embedding-a-helper-tool-in-a-sandboxed-app)
- [Adding a Command Line Tool Helper to a Mac App Store App | Twocanoes](https://twocanoes.com/adding-a-command-line-tool-helper-to-a-mac-app-store-app/)
