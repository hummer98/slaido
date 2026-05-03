# Release Automation — 署名・公証 + Homebrew Cask 自動更新

slAIdo のリリースは「ローカル: tag push」→「CI A: ビルド + 署名 + 公証 + Release 作成」→「CI B: Homebrew Cask 自動更新」の 3 段で完結する。本ドキュメントはこの 2 本立て workflow の運用情報をまとめる。

- **想定読者**: slAIdo メンテナー（リリース実行者・Secret 管理者）
- **前提**: ローカル署名・公証のセットアップは [`docs/signing-setup.md`](signing-setup.md) で完了済み
- **対象アーキ**: macOS / Apple Silicon (`arm64`) のみ。Universal Binary 化は未対応

## 1. 構成概要

### 1.1 2 本立て workflow の役割

| Workflow | ファイル | トリガー | 役割 |
|---|---|---|---|
| **A. Build and Release** | [`.github/workflows/build-release.yml`](../.github/workflows/build-release.yml) | `push` tags `v*.*.*` / `workflow_dispatch` | macos-14 runner で codesign → notarize → zip/dmg 生成 → GitHub Release 作成 |
| **B. Update Homebrew Cask** | [`.github/workflows/update-tap.yml`](../.github/workflows/update-tap.yml) | `workflow_run`（Build and Release 完了） / `workflow_dispatch` | build-release.yml の完了を検知して `hummer98/homebrew-slaido` の `Casks/slaido.rb` を自動更新 |

2 本立てにしている理由:

1. **runner 時間の使い分け**: 重い build（〜30 分）と軽い cask 書き換え（数十秒）を独立した workflow にすると、cask 更新だけを再実行したいときに build を走らせずに済む
2. **権限の分離**: build 側は自リポジトリへの release 作成（`contents: write`）で済むが、cask 側は別リポジトリ（`hummer98/homebrew-slaido`）への push が必要なので、別途 GitHub App (`hummer98-tap-updater`) のインストールトークンを使う
3. **独立リトライ**: 片方だけ失敗した場合（例: notarize は成功したが Apple CDN 反映待ちで cask 更新がコケた等）に独立してリトライできる

### 1.2 起動シーケンス

```mermaid
sequenceDiagram
    actor Maintainer
    participant Slaido as slaido repo
    participant BuildRel as build-release.yml
    participant Releases as GitHub Releases
    participant UpdateTap as update-tap.yml
    participant Tap as homebrew-slaido repo

    Maintainer->>Slaido: git push --tags v0.X.0
    Slaido-->>BuildRel: tag push event
    BuildRel->>BuildRel: checkout / bun install / bun test src/
    BuildRel->>BuildRel: keychain create + p12 import
    BuildRel->>BuildRel: bun run build:prod (codesign + fetchOpencode)
    BuildRel->>BuildRel: fastlane mac notarize_app
    BuildRel->>BuildRel: package.sh + smoke-test.sh
    BuildRel->>Releases: gh release create v0.X.0 (zip + dmg)
    BuildRel-->>UpdateTap: workflow_run completed event
    UpdateTap->>Releases: gh release view (zip URL 取得)
    UpdateTap->>UpdateTap: curl + shasum (zip SHA-256 計算)
    UpdateTap->>Tap: checkout (GitHub App token)
    UpdateTap->>UpdateTap: sed で version / sha256 を更新
    UpdateTap->>Tap: git commit + push
```

### 1.3 全体フロー

```mermaid
flowchart TD
    A[git push --tags v*.*.*] --> B[build-release.yml]
    B --> C{event_name}
    C -->|push| D[Codesign + Notarize + Package]
    C -->|workflow_dispatch| E[Codesign + Notarize + Package]
    D --> F[gh release create]
    E --> G[upload-artifact 7d retention]
    F --> H[build-release.yml completed]
    G --> H
    H --> I{workflow_run.event}
    I -->|push| J[update-tap.yml 起動]
    I -->|workflow_dispatch| K[skip dry-run]
    J --> L[Casks/slaido.rb 更新]
    L --> M[hummer98/homebrew-slaido に push]
```

## 2. Workflow A: build-release.yml（署名・公証・Release 作成）

### 2.1 トリガーと dry-run

| イベント | 挙動 |
|---|---|
| `push` (tag `v*.*.*`) | 本番 release を作成。既存 release があれば `gh release upload --clobber` で asset を上書き（CI 二重起動 / retry の冪等性確保） |
| `workflow_dispatch` | release は作らず `actions/upload-artifact@v4` で zip/dmg を 7 日保持（dry-run） |

- `concurrency.group=build-release-${{ github.ref }}`、`cancel-in-progress: false`（中途半端な release を残さない）
- `permissions: contents: write`
- runner: `macos-14` / `timeout-minutes: 45`

### 2.2 ステップ概要

1. `actions/checkout@v4`
2. `oven-sh/setup-bun@v2`（`bun-version: latest`）
3. **VERSION 解決**: `push` 時は tag から、`workflow_dispatch` 時は `package.json` から
4. `ruby/setup-ruby@v1`（`3.3`、`bundler-cache: false`）
5. fastlane 利用可能性チェック（無ければ `gem install fastlane --no-document`）
6. **一時 keychain の作成 & .p12 import**（[§2.3](#23-一時-keychain-構築の要点) の順序を厳守）
7. `bun install --frozen-lockfile`
8. `bun test src/`（`tests/e2e/` は CI 対象外）
9. `bun run build:prod`（内部で `bun install && bun run fetchOpencode && electrobun build --env=stable`。Electrobun が helper / launcher / framework / dmg まで deep に codesign）
10. `fastlane mac notarize_app`（`timeout-minutes: 25`）
11. `bash scripts/package.sh <version>` で zip/dmg を `dist/` に生成
12. `bash scripts/smoke-test.sh build/stable-macos-arm64/slAIdo.app`（`spctl --assess` で Notarized 検出 → `codesign --verify --deep --strict` → `stapler validate` → 起動ログ確認）
13. **push 時のみ**: `gh release create` または `gh release upload --clobber`
14. **dispatch 時のみ**: `actions/upload-artifact@v4`（`retention-days: 7`、`if-no-files-found: error`）
15. **`if: always()`**: 一時 keychain を削除し、default-keychain を `~/Library/Keychains/login.keychain-db` に戻す

### 2.3 一時 keychain 構築の要点

CI 環境で codesign が UI prompt を出さずに動くためには、以下の順序を厳守する必要がある:

1. `security create-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN_PATH"`
2. `security set-keychain-settings -lut 21600`（6 時間後にロック）
3. `security unlock-keychain`
4. `security list-keychains -d user -s` で **既存 search-list を保ったまま追加**（runner 既定 keychain を壊さない）
5. `security default-keychain -s` で default に昇格
6. `security import` で `.p12` を取り込み
7. `security set-key-partition-list -S apple-tool:,apple:,codesign:`（**漏れると codesign が UI prompt で hang する**）

`.p12` の base64 復号は `RUNNER_TEMP` 配下で行い、import 直後に `rm -f` で削除する（防御層深め）。`Cleanup keychain` step は `if: always()` なので、途中失敗時にも keychain は確実に削除される。

### 2.4 使用 Secrets

7 個 + GitHub 自動付与の `GITHUB_TOKEN`:

- `KEYCHAIN_PASSWORD` / `DEVELOPER_ID_P12_BASE64` / `DEVELOPER_ID_P12_PASSWORD` / `ELECTROBUN_DEVELOPER_ID`
- `APP_STORE_CONNECT_API_KEY_KEY_ID` / `APP_STORE_CONNECT_API_KEY_ISSUER_ID` / `APP_STORE_CONNECT_API_KEY_KEY`
- `GITHUB_TOKEN`（Release 作成のみ）

詳細は [§4 GitHub Secrets 一覧](#4-github-secrets-一覧) を参照。

## 3. Workflow B: update-tap.yml（Homebrew Cask 自動更新）

### 3.1 トリガーとガード

| イベント | 挙動 |
|---|---|
| `workflow_run` (`Build and Release` 完了) | `workflow_run.conclusion == 'success' && workflow_run.event == 'push'` の場合のみ発火（成功した tag push ビルドのみ。dry-run = workflow_dispatch 由来は除外） |
| `workflow_dispatch` (`inputs.tag` 必須) | ガードを通さず常に許可。過去 tag を指定した手動再実行に使う |

- `concurrency.group=update-homebrew-cask`、`cancel-in-progress: false`
- `permissions: contents: read`（自リポジトリは読むだけ。tap への push は GitHub App トークンで別経路）
- runner: `macos-latest`

> **トリガーが `release: published` ではなく `workflow_run` な理由**: 旧方式では build-release.yml の release 作成と asset upload の間にレースが発生し、update-tap が先に走って zip asset を見つけられず失敗する事故が起きた（mado プロジェクトで実証済み）。`workflow_run` であれば build-release の完了を確実に待ってから発火する。

### 3.2 ステップ概要

1. tag/version 解決（`workflow_run.head_branch` または `inputs.tag`）。`build-release.yml` は `on: push: tags: ['v*.*.*']` でしか push 起動しないため、`if:` で `event == 'push'` を通った時点で `head_branch` には tag 名（例: `v0.2.0`）が入っている
2. `gh release view` で `*-macos-arm64.zip` の URL を取得
3. `curl -fL --retry 3 --retry-delay 5` で zip を取得 → `shasum -a 256` で SHA-256 計算
4. `actions/create-github-app-token@v1` で `hummer98-tap-updater` GitHub App のインストールトークンを取得（`repositories: homebrew-slaido`、`owner: hummer98`）
5. `actions/checkout@v4` で `hummer98/homebrew-slaido` を `tap/` 配下に clone（`token:` に App トークンを渡す）
6. `sed -i ''` で `Casks/slaido.rb` の `version` 行と `sha256` 行を置換（`url` 行は `v#{version}` 補間のため不変）
7. **検証**: `version "X.Y.Z"` / `sha256 "..."` / `v#{version}` の 3 つが反映されているか `grep -q` で確認（失敗なら `::error::` で exit 1）
8. `git config` → `git add` → 差分なしなら `No changes (already up-to-date)` で exit 0、差分があれば `git commit -m "chore: bump slaido to v$VERSION"` → `git push`

### 3.3 使用 Secrets

- `APP_ID`（`hummer98-tap-updater` GitHub App の App ID）
- `APP_PRIVATE_KEY`（同 App の Private key、PEM 形式）
- `GITHUB_TOKEN`（自リポジトリの release 参照のみ。GitHub 自動付与）

詳細は [§4 GitHub Secrets 一覧](#4-github-secrets-一覧) を参照。

## 4. GitHub Secrets 一覧

### 4.1 一覧表

slAIdo のリリース CI が参照する Secret は **9 個 + 自動付与の `GITHUB_TOKEN`**。

| 区分 | Secret 数 | 真実の出所（参照先） |
|---|---|---|
| 署名・公証関係（build-release.yml） | 7 | [`docs/signing-setup.md` §8](signing-setup.md#8-phase-2-で実施github-secrets-の登録) |
| Tap 自動更新関係（update-tap.yml） | 2 | 本ドキュメント [§5](#5-github-app-hummer98-tap-updater-のセットアップ) |
| 自リポジトリ操作（自動付与） | 1 | `GITHUB_TOKEN`（明示登録不要） |

#### 4.1.1 署名・公証関係（build-release.yml が参照）

`docs/signing-setup.md §8` の表をそのまま正とする。Secret 名・取得手順・登録方法はすべて [`docs/signing-setup.md §8`](signing-setup.md#8-phase-2-で実施github-secrets-の登録) を参照すること（**本ドキュメントでは二重管理しない**）。Secret 名のみ列挙すると次の 7 個:

- `ELECTROBUN_DEVELOPER_ID`
- `DEVELOPER_ID_P12_BASE64`
- `DEVELOPER_ID_P12_PASSWORD`
- `APP_STORE_CONNECT_API_KEY_KEY_ID`
- `APP_STORE_CONNECT_API_KEY_ISSUER_ID`
- `APP_STORE_CONNECT_API_KEY_KEY`
- `KEYCHAIN_PASSWORD`

#### 4.1.2 Tap 自動更新関係（update-tap.yml が参照）

`hummer98/homebrew-slaido` への push 専用に、GitHub App `hummer98-tap-updater` のインストールトークンを `actions/create-github-app-token@v1` で取得する。PAT は使わない（失効ローテ運用を不要にするため）。

| Secret | 用途 | 取得手順 |
|---|---|---|
| `APP_ID` | `hummer98-tap-updater` GitHub App の App ID（数字） | [§5.3](#53-app_id--app_private_key-の取得と-secret-登録) |
| `APP_PRIVATE_KEY` | 同 App の Private key（`.pem` の中身、改行込み PEM） | [§5.3](#53-app_id--app_private_key-の取得と-secret-登録) |

### 4.2 登録手順

1. `https://github.com/hummer98/slaido/settings/secrets/actions` を開く
2. **New repository secret** を押下
3. **Name** に上記の Secret 名（タイポ厳禁。CI 側のステップが `secrets.<NAME>` を参照する）、**Secret** に値を貼り付ける
4. **Add secret** を押下

複数行の値（`APP_STORE_CONNECT_API_KEY_KEY` の PEM、`DEVELOPER_ID_P12_BASE64` の base64、`APP_PRIVATE_KEY` の PEM）はそのまま貼り付けて構わない。GitHub Actions の `secrets.*` 経由で env に渡せば改行は保持される（`echo` 等で再エンコードしないことが前提）。

`gh` CLI で一括登録する場合の例:

```bash
# PEM のように改行を含む値はファイル経由で渡す
gh secret set APP_PRIVATE_KEY < ~/Downloads/hummer98-tap-updater.YYYY-MM-DD.private-key.pem

# 短い値はコマンドラインで
gh secret set APP_ID --body "1234567"
```

## 5. GitHub App (`hummer98-tap-updater`) のセットアップ

### 5.1 既存 mado で作成済みの App を slaido に install する手順（推奨）

mado で既に同名 App (`hummer98-tap-updater`) が稼働中なら、再利用するのが最も少ない作業で済む。

1. `https://github.com/settings/apps` を開く（owner: `hummer98`）
2. `hummer98-tap-updater` を選択 → **Install App** タブ
3. **hummer98** 配下を選択 → **Repository access** に **`hummer98/homebrew-slaido` を追加** → Save
4. これで App は `homebrew-mado` と `homebrew-slaido` の 2 リポジトリに対して `Contents: Read and write` を持つ
5. App ID と Private key は mado 用の値をそのまま slaido リポジトリの Secret (`APP_ID` / `APP_PRIVATE_KEY`) にも登録（[§4.2](#42-登録手順)）

### 5.2 App を slaido 専用に新規作成する場合

mado と独立で App を運用したい場合（権限分離・ローテーション分離など）の手順:

1. `https://github.com/settings/apps/new` を開く
2. 以下を設定:
   - **GitHub App name**: `hummer98-slaido-tap-updater`（任意、global で一意）
   - **Homepage URL**: `https://github.com/hummer98/slaido`
   - **Webhook**: チェックを外す（Active を OFF）
   - **Repository permissions**:
     - `Contents`: Read and write
     - `Metadata`: Read-only（自動付与）
   - **Where can this GitHub App be installed?**: Only on this account
3. **Create GitHub App** を押下
4. 作成後の **Install App** タブから `hummer98/homebrew-slaido` を選んで install
5. Private key を **Generate a private key** で `.pem` ダウンロード（**1 回限り**、紛失したら再生成）
6. App ID と Private key を slaido の Secret (`APP_ID` / `APP_PRIVATE_KEY`) に登録（[§4.2](#42-登録手順)）

新規作成の場合は `update-tap.yml` の `actions/create-github-app-token@v1` の `repositories: homebrew-slaido` はそのままでよい（同じ App を mado に install していないため）。

### 5.3 `APP_ID` / `APP_PRIVATE_KEY` の取得と Secret 登録

- **APP_ID**: App の Settings ページ上部 **About** セクションの「App ID」（数字、例: `1234567`）
- **APP_PRIVATE_KEY**: Settings → **Private keys** → **Generate a private key** → 自動でダウンロードされる `.pem` の中身全部（`-----BEGIN RSA PRIVATE KEY-----` から `-----END RSA PRIVATE KEY-----` まで改行込み）

両方を [§4.2 登録手順](#42-登録手順) に従って `https://github.com/hummer98/slaido/settings/secrets/actions` から登録する。

## 6. リリース時のオペレーション

### 6.1 通常リリース（CI 任せ）

メンテナーがローカルでやることは **3 つだけ**:

```bash
# 1. version bump (package.json / electrobun.config.ts / CHANGELOG.md)
#    既存の /release コマンドの該当ステップを参考に手動編集する
$EDITOR package.json electrobun.config.ts CHANGELOG.md

# 2. commit
git add package.json electrobun.config.ts CHANGELOG.md
git commit -m "chore: release v0.2.0"

# 3. tag & push
git tag v0.2.0
git push origin master --tags
```

`git push origin master --tags` で tag が push されると:

1. **build-release.yml** が起動 → 30〜45 分で release 作成 + asset upload
2. **update-tap.yml** が `workflow_run` で発火 → `hummer98/homebrew-slaido` の `Casks/slaido.rb` を更新

両 workflow が green になれば `brew update && brew upgrade --cask slaido` で新版が降ってくる。

### 6.2 dry-run の使い方（workflow_dispatch）

本番 release を汚さず署名・公証パイプラインの正常性を確認したい場合:

1. `https://github.com/hummer98/slaido/actions/workflows/build-release.yml` を開く
2. **Run workflow** を押下（branch は通常 `master`）
3. 実行ログで notarize / smoke-test の成功を確認
4. **Artifacts** セクションから `slAIdo-v<VERSION>-macos-arm64` をダウンロード（`retention-days: 7`）
5. ローカルで展開して `spctl --assess --type execute --verbose=2 slAIdo.app` を実行し、`accepted source=Notarized Developer ID` が出ることを確認

> ⚠ `workflow_dispatch` では release が作られないため、`update-tap.yml` は発火しない。Cask 更新の動作確認は [§6.3](#63-update-tapyml-の手動再実行) で別途行うこと。

### 6.3 update-tap.yml の手動再実行

過去 tag に対して Cask を再生成したい / cask 更新だけ失敗してリトライしたい場合:

1. `https://github.com/hummer98/slaido/actions/workflows/update-tap.yml` を開く
2. **Run workflow** → `tag` 入力欄にリリース tag（例: `v0.2.0`）を指定
3. 実行ログで `git diff` を確認し、差分なしなら `No changes (already up-to-date)` で exit 0（同値書き換えのため `Commit & push` step でスキップ）

### 6.4 失敗時のリカバリー

| 失敗箇所 | 兆候 | 対処 |
|---|---|---|
| `Create temporary keychain & import certificate` | `security create-keychain` が exit 1 | `KEYCHAIN_PASSWORD` 未登録 → [§4.2](#42-登録手順) で登録して **Re-run jobs** |
| 〃 | `security import` が `errSecAuthFailed` (-25293) | `DEVELOPER_ID_P12_PASSWORD` 不一致 → 値を再確認して上書き登録 → **Re-run jobs** |
| `Build (codesign)` | codesign が `Developer ID なし` で fail | `ELECTROBUN_DEVELOPER_ID` 未登録 / 値タイポ → 上書き登録 → **Re-run jobs** |
| `Build (codesign)` | `fetchOpencode` がネットワーク失敗 (`scripts/fetch-opencode.ts` 内の HTTP fetch エラー) | runner の一時的な疎通障害が大半。**Re-run jobs を 1 度実行するだけで復旧** することがほとんど。連続失敗するようなら `bin/darwin-arm64/opencode` をリポジトリにコミットする案を将来検討 |
| `Notarize app & dmg` | fastlane が `Invalid` を返す | `xcrun notarytool log <uuid>` を runner ログから探す。よくある原因は entitlements / hardened runtime ずれ（[`docs/signing-setup.md §6`](signing-setup.md#6-トラブルシューティング) と同じ）|
| `Create GitHub Release` | `gh release create` が 422 で fail | 既存 release との衝突（手動 `/release` と並走など） → workflow が次回 run で `gh release upload --clobber` 経路に入るので **Re-run jobs** で吸収可能 |
| `update-tap.yml` の `Generate GitHub App token` | 401/403 | App install 抜け or App private key 期限切れ → [§5.1](#51-既存-mado-で作成済みの-app-を-slaido-に-install-する手順推奨) または [§5.3](#53-app_id--app_private_key-の取得と-secret-登録) を再実行 |
| `update-tap.yml` の `Fetch zip asset URL` | `No macos-arm64.zip asset found` | release 作成と asset upload の間で `update-tap.yml` が走った稀なケース（通常 `workflow_run` トリガーで防いでいる）→ workflow_dispatch から手動再実行 |

> **補足**: `Cleanup keychain` step は `if: always()` で必ず走る。`KEYCHAIN_PATH` が未設定の早期失敗時は no-op、設定済みなら `delete-keychain` + default-keychain 復元。失敗時にも runner に keychain を残さない設計。

GitHub Actions が全停止 / build-release.yml が連続失敗するなど CI に頼れない場合の手動フルパス手順は、既存の [`/release` slash command (.claude/commands/release.md)](../.claude/commands/release.md) に集約されている。本ドキュメントは重複させない（手動経路は `/release` が真実の出所）。

## 7. 証明書・API Key の失効予定日

### 7.1 失効予定日表

新規発行のたびに更新する。失効予定日の **7 日前**までに再発行すること。

| 対象 | 種別 | 発行日 | 失効予定日 | 再発行手順 | メモ |
|---|---|---|---|---|---|
| Developer ID Application 証明書 | 5 年有効 | TBD | TBD（発行日 + 5 年） | [`docs/signing-setup.md §2`](signing-setup.md#2-developer-id-application-証明書の取り込み) | 失効すると `build-release.yml` の codesign / notarize step が失敗。`security find-identity` から消えるのも兆候 |
| App Store Connect API Key | 失効なし | TBD | — | [`docs/signing-setup.md §3`](signing-setup.md#3-app-store-connect-api-key-の発行) | Apple 側に有効期限はないが、漏洩疑いで revoke。ローテ目安は 1 年 |
| `KEYCHAIN_PASSWORD` | 任意 | TBD | TBD（推奨ローテ 1 年） | `openssl rand -base64 24` を再生成し Secret 上書き | 漏洩リスクは低いが定期ローテ推奨 |

> **GitHub App (`hummer98-tap-updater`)** はインストールトークン方式のため、PAT のような明示的な失効予定日はない。Private key を再生成した場合のみ `APP_PRIVATE_KEY` Secret を上書きする。

### 7.2 リマインダー設定例（任意）

失効予定日の 7 日前に通知されるよう、運用者が好みのツールでリマインダー登録する:

- **macOS Calendar**:

  ```bash
  osascript -e 'tell application "Calendar" to make new event at calendar "Home" with properties {summary:"slaido Developer ID 証明書 失効 7 日前", start date:date "YYYY/MM/DD HH:MM"}'
  ```

- **GitHub Issue 自動生成**: 失効予定日の 7 日前に警告 issue を自動生成する cron workflow を追加する

## 8. `/release` コマンドとの位置づけ

slAIdo には CI 化以前から手動リリース用の slash command [`/release` (`.claude/commands/release.md`)](../.claude/commands/release.md) が存在する。CI 完成後の運用方針は次のとおり:

### 8.1 基本ルール: CI が正、`/release` はバックアップ

- **通常運用**: tag push → CI（build-release + update-tap）が走り、release 作成と Cask 更新が完了する。**メンテナーは `/release` を起動しない**
- **バックアップ用途**: GitHub Actions が全停止、または build-release.yml が連続失敗する非常時のみ、ローカル機で `/release` を実行してフルパスを手動でこなす（手順は `.claude/commands/release.md` を参照）

`.claude/commands/release.md` 自体は CI 化後も削除・改変しない。手動フォールバック手順の真実の出所として残し、本ドキュメントとの重複を避ける。

### 8.2 並走時の注意点（同じ tag に対する CI と /release の競合）

tag push 後に `/release` を起動すると、`/release` 内の `gh release create` と CI 側の `gh release create` が同じ tag に対して動き、後発が 422 で失敗する（あるいは `--clobber` で上書きが起きる）。Cask 更新も二重に走り、tap への push が衝突する可能性がある。

これを避けるため、運用ルールとして次を厳守する:

1. **tag push の前に手動で `/release` を起動して途中で止める運用は禁止**（tag push が CI を起動するため）
2. **tag push 後は CI 完了を待ってから手動操作する**。CI が完走すれば release / cask とも自動更新されるので追加操作は不要
3. **CI が連続失敗するなどで `/release` に切り替える場合は、まず CI を `cancel` し、release 作成済みなら `gh release delete` で消してから `/release` を実行**（または `--clobber` で上書きされることを許容して `/release` を進める）

このルールはコード変更を伴わない。`.claude/commands/release.md` / `electrobun.config.ts` / `fastlane/Fastfile` / `scripts/package.sh` / `scripts/smoke-test.sh` には触らず、運用ドキュメント（本ファイル §8）と作業前のメンテナーの判断のみで吸収する。

## 9. 将来の改善案

- **macOS Universal Binary 対応**: 現状 `arm64` のみ build。Intel macOS をサポートするなら `x86_64 + arm64` の lipo を行うか、別 runner で並列ビルドして 2 種の zip/dmg を release に添付する
- **`bin/darwin-arm64/opencode` をリポジトリに同梱**: 現在は build 時に `scripts/fetch-opencode.ts` がネットワーク fetch するため、CI runner からの疎通障害で flaky 化するリスクがある。バイナリサイズと引き換えに git commit する案
- **Release Notes の自動生成**: `git-cliff` / `release-please` を取り入れて、`--notes "Automated release for $TAG..."` の手書き部分を CHANGELOG から自動生成
- **prerelease 用 tap**: `prerelease == true` の release を別 tap（`hummer98/homebrew-slaido-beta` 等）に流し、`brew install --cask hummer98/slaido-beta/slaido` で beta 配布できるようにする
- **`bun install --frozen-lockfile` の保証を build:prod 全体に拡張**: 現状 `Install dependencies` step は `--frozen-lockfile` だが、`bun run build:prod` は内部で `bun install`（`--frozen-lockfile` なし）を再実行する。長期的には `package.json:13` から `bun install` を抜くか、CI 側で lockfile hash の前後比較 step を追加する
