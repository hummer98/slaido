# Release - slAIdo 新バージョンリリース

slAIdo の新バージョンをリリースするための一連の手順を自動化するコマンド。

**役割分担**: slaido は CI を持たないため、本コマンドが **ローカルで全工程**
（version bump → tag push → ローカル build:prod → fastlane 公証 → GitHub Release）
を担当する。将来 CI を整備したら mado パターンに揃え替える前提。

詳細な署名・公証セットアップは `docs/signing-setup.md` を参照。

## --auto オプション

`/release --auto` で実行すると、対話なしの完全自動リリースが実行される。

### 動作の違い

| 項目 | 通常モード (`/release`) | 自動モード (`/release --auto`) |
|------|-------------------------|-------------------------------|
| 未コミット変更 | ユーザーに確認を求める | ドキュメント変更のみスキップ、ソースコードはエラー |
| バージョン番号 | ユーザーに提案して確認 | コミットログから自動判定 |
| 確認プロンプト | 各ステップで確認 | 全てスキップ |

### 自動判定ルール

**バージョン番号の自動判定（Semantic Versioning）:**
- `BREAKING CHANGE:` を含むコミット → **major** インクリメント (0.5.0 → 1.0.0)
- `feat:` プレフィックスのコミット → **minor** インクリメント (0.5.0 → 0.6.0)
- `fix:`, `docs:`, `chore:` のみ → **patch** インクリメント (0.5.0 → 0.5.1)

**未コミット変更の扱い:**
- `.md`, `.json` ファイルのみ → 警告してスキップ
- `.ts`, `.tsx`, `.js` 等のソースコード → エラー終了

**初回リリースの特殊動作:**
- 前回のタグが存在しない場合（`git describe --tags --abbrev=0` が失敗）、
  現在の `package.json.version` をそのまま `NEXT_VERSION` として採用し、
  auto バンプは実施しない。CHANGELOG の `[Unreleased]` 以降の追記もスキップ。

## 実行手順

以下の順序で実行する。

### 1. 前提条件チェック

main ブランチ（slaido は `master`）、テスト通過、未コミット変更の確認、署名 env 確認。

```bash
# main ブランチ確認 (slaido は master)
MAIN_BRANCH="master"
BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [ "$BRANCH" != "$MAIN_BRANCH" ]; then
  echo "❌ $MAIN_BRANCH ブランチ以外では実行不可 (現在: $BRANCH)"
  exit 1
fi

# リモートと同期
git fetch origin "$MAIN_BRANCH" || { echo "❌ git fetch origin $MAIN_BRANCH 失敗"; exit 1; }

AHEAD=$(git rev-list --count "origin/$MAIN_BRANCH..HEAD")
BEHIND=$(git rev-list --count "HEAD..origin/$MAIN_BRANCH")

if [ "$BEHIND" -gt 0 ]; then
  git pull --ff-only origin "$MAIN_BRANCH" || {
    echo "❌ git pull --ff-only 失敗（分岐の可能性）。手動で解消してください。"
    exit 1
  }
  echo "✅ origin/$MAIN_BRANCH に追従（$BEHIND コミット pull）"
fi

if [ "$AHEAD" -gt 0 ]; then
  git push origin "$MAIN_BRANCH" || { echo "❌ git push 失敗"; exit 1; }
  echo "✅ ローカルコミットを push（$AHEAD コミット）"
fi

# bun test
bun test || { echo "❌ bun test 失敗"; exit 1; }

# 署名 env 4 つの存在確認
for v in ELECTROBUN_DEVELOPER_ID APP_STORE_CONNECT_API_KEY_KEY_ID \
         APP_STORE_CONNECT_API_KEY_ISSUER_ID APP_STORE_CONNECT_API_KEY_KEY; do
  if [ -z "${!v}" ]; then
    echo "❌ $v が未設定。docs/signing-setup.md §4 を参照"
    exit 1
  fi
done
echo "✅ 署名 env OK"

# 未コミット変更チェック
UNCOMMITTED=$(git status --porcelain)

if [ -n "$UNCOMMITTED" ]; then
  if [[ "$0" == "--auto" ]]; then
    SOURCE_CHANGES=$(echo "$UNCOMMITTED" | grep -E '\.(ts|tsx|js|jsx|mjs|cjs|sh)$' || true)
    if [ -n "$SOURCE_CHANGES" ]; then
      echo "❌ ソースコードに未コミット変更があります。--auto モードではリリースできません。"
      echo "$SOURCE_CHANGES"
      exit 1
    fi
    DOC_CHANGES=$(echo "$UNCOMMITTED" | grep -E '\.(md|json)$' || true)
    if [ -n "$DOC_CHANGES" ]; then
      echo "⚠️  以下のドキュメント変更をスキップします:"
      echo "$DOC_CHANGES"
    fi
  else
    echo "⚠️  未コミットの変更があります:"
    echo "$UNCOMMITTED"
    echo ""
    echo "コミットしてから再実行してください。"
    exit 1
  fi
fi
```

### 2. バージョン決定

```bash
CURRENT_VERSION=$(node -p "require('./package.json').version")
echo "現在のバージョン: $CURRENT_VERSION"

LATEST_TAG=$(git describe --tags --abbrev=0 2>/dev/null || echo "")

if [ -z "$LATEST_TAG" ]; then
  # 初回リリース: 現在の version をそのまま採用
  NEXT_VERSION="$CURRENT_VERSION"
  echo "📦 初回リリース: $NEXT_VERSION"
else
  echo "前回のリリースタグ: $LATEST_TAG"

  if [[ "$0" == "--auto" ]]; then
    COMMITS=$(git log ${LATEST_TAG}..HEAD --oneline)

    if echo "$COMMITS" | grep -qi "BREAKING CHANGE:"; then
      VERSION_TYPE="major"
    elif echo "$COMMITS" | grep -qE "^[a-f0-9]+ feat:"; then
      VERSION_TYPE="minor"
    else
      VERSION_TYPE="patch"
    fi
    echo "📦 自動判定されたバージョンタイプ: $VERSION_TYPE"

    IFS='.' read -r -a VERSION_PARTS <<< "${CURRENT_VERSION}"
    MAJOR="${VERSION_PARTS[0]}"
    MINOR="${VERSION_PARTS[1]}"
    PATCH="${VERSION_PARTS[2]}"

    case "$VERSION_TYPE" in
      major) MAJOR=$((MAJOR + 1)); MINOR=0; PATCH=0 ;;
      minor) MINOR=$((MINOR + 1)); PATCH=0 ;;
      patch) PATCH=$((PATCH + 1)) ;;
    esac

    NEXT_VERSION="$MAJOR.$MINOR.$PATCH"
    echo "✅ 次のバージョン: $NEXT_VERSION"
  else
    echo ""
    echo "最近のコミット:"
    git log --oneline -10
    echo ""
    echo "**バージョンタイプの判定基準:**"
    echo "- **patch**: バグ修正のみ（fix:, docs: など）"
    echo "- **minor**: 新機能追加（feat: など）"
    echo "- **major**: 破壊的変更（BREAKING CHANGE）"
    echo ""
    echo "次のバージョンを決定してください（例: 0.2.0）"
    exit 1  # ユーザーに確認を促すため一旦終了
  fi
fi
```

### 3. package.json / electrobun.config.ts バージョン更新

```bash
# package.json
sed -i '' "s/\"version\": \".*\"/\"version\": \"$NEXT_VERSION\"/" package.json
echo "✅ package.json を $NEXT_VERSION に更新"

# electrobun.config.ts（app.version 固有のパターン）
sed -i '' "s/version: \".*\",/version: \"$NEXT_VERSION\",/" electrobun.config.ts
echo "✅ electrobun.config.ts を $NEXT_VERSION に同期"
```

初回リリース時 `NEXT_VERSION == CURRENT_VERSION` の場合、sed は no-op で問題なし。

### 4. CHANGELOG.md 更新

初回リリース時は雛形に既に `[0.1.0]` エントリがあるためスキップ。
2 回目以降は `[Unreleased]` 直下に `[$NEXT_VERSION]` セクションを挿入。

```bash
if [ -z "$LATEST_TAG" ]; then
  echo "ℹ️  初回リリース: CHANGELOG.md は雛形のまま使用"
else
  COMMITS=$(git log ${LATEST_TAG}..HEAD --oneline)
  RELEASE_DATE=$(date +"%Y-%m-%d")

  echo "## [$NEXT_VERSION] - $RELEASE_DATE" > /tmp/slaido_changelog_entry.md
  echo "" >> /tmp/slaido_changelog_entry.md

  FEAT_COMMITS=$(echo "$COMMITS" | grep -E "^[a-f0-9]+ feat:" || true)
  if [ -n "$FEAT_COMMITS" ]; then
    echo "### Added" >> /tmp/slaido_changelog_entry.md
    echo "$FEAT_COMMITS" | sed 's/^[a-f0-9]* feat: /- /' >> /tmp/slaido_changelog_entry.md
    echo "" >> /tmp/slaido_changelog_entry.md
  fi

  FIX_COMMITS=$(echo "$COMMITS" | grep -E "^[a-f0-9]+ fix:" || true)
  if [ -n "$FIX_COMMITS" ]; then
    echo "### Fixed" >> /tmp/slaido_changelog_entry.md
    echo "$FIX_COMMITS" | sed 's/^[a-f0-9]* fix: /- /' >> /tmp/slaido_changelog_entry.md
    echo "" >> /tmp/slaido_changelog_entry.md
  fi

  OTHER_COMMITS=$(echo "$COMMITS" | grep -vE "^[a-f0-9]+ (feat|fix):" || true)
  if [ -n "$OTHER_COMMITS" ]; then
    echo "### Changed" >> /tmp/slaido_changelog_entry.md
    echo "$OTHER_COMMITS" | sed 's/^[a-f0-9]* /- /' >> /tmp/slaido_changelog_entry.md
    echo "" >> /tmp/slaido_changelog_entry.md
  fi

  awk -v entry_file=/tmp/slaido_changelog_entry.md '
    /^## \[Unreleased\]/ {
      print
      print ""
      while ((getline line < entry_file) > 0) print line
      close(entry_file)
      next
    }
    { print }
  ' CHANGELOG.md > /tmp/slaido_changelog_new.md
  mv /tmp/slaido_changelog_new.md CHANGELOG.md
  rm -f /tmp/slaido_changelog_entry.md

  echo "✅ CHANGELOG.md を更新"
fi
```

### 5. version bump をコミット & push

slaido は branch protection 設定無し / 単独メンテナー想定なので、master に直接コミット。
チーム運用に切り替える際は mado パターン（release branch + PR）に変更する。

```bash
git add package.json electrobun.config.ts CHANGELOG.md
git commit -m "chore: bump version to v$NEXT_VERSION"
git push origin "$MAIN_BRANCH"
echo "✅ v$NEXT_VERSION の version bump を $MAIN_BRANCH に push"
```

### 6. Git タグの作成 & プッシュ

```bash
git tag "v$NEXT_VERSION"
git push origin "v$NEXT_VERSION"
echo "🚀 tag v$NEXT_VERSION を push"
```

### 7. ローカルで build:prod + 公証

slaido は CI を持たないので、ここからの工程はリリース実行マシンで完結する。
所要時間の目安: build:prod 1〜2 分、notarize 5〜15 分。

```bash
# 7a. ビルド（codesign 済み .app と .dmg を生成）
bun run build:prod || { echo "❌ build:prod 失敗"; exit 1; }
echo "✅ build:prod 完了"

# 7b. 公証 + staple
fastlane mac notarize_app || { echo "❌ notarize 失敗"; exit 1; }
echo "✅ notarize 完了"

# 7c. 検証
APP_PATH="build/stable-macos-arm64/slAIdo.app"
codesign --verify --deep --strict --verbose=2 "$APP_PATH" || { echo "❌ codesign 検証失敗"; exit 1; }
spctl --assess --type execute --verbose=2 "$APP_PATH" 2>&1 | grep -q "Notarized Developer ID" || {
  echo "❌ spctl で Notarized Developer ID 検証失敗"
  exit 1
}
stapler validate "$APP_PATH" || { echo "❌ stapler validate 失敗"; exit 1; }
echo "✅ 署名・公証・staple 検証 OK"

# 7d. パッケージング（zip + dmg）
bash scripts/package.sh "$NEXT_VERSION" || { echo "❌ package.sh 失敗"; exit 1; }

# 7e. スモークテスト
bash scripts/smoke-test.sh "$APP_PATH" || { echo "❌ smoke-test 失敗"; exit 1; }
```

### 8. GitHub Release 作成 & asset upload

CHANGELOG の該当セクションを抜き出して Release notes にする。

```bash
RELEASE_NOTES=$(awk -v version="$NEXT_VERSION" '
  $0 ~ "^## \\[" version "\\]" { flag=1; next }
  /^## \[/ { flag=0 }
  flag
' CHANGELOG.md)

gh release create "v$NEXT_VERSION" \
  --title "slAIdo v$NEXT_VERSION" \
  --notes "$RELEASE_NOTES" \
  || { echo "❌ gh release create 失敗"; exit 1; }

gh release upload "v$NEXT_VERSION" "dist/slAIdo-v${NEXT_VERSION}-macos-arm64.zip"
[ -f "dist/slAIdo-v${NEXT_VERSION}-macos-arm64.dmg" ] && \
  gh release upload "v$NEXT_VERSION" "dist/slAIdo-v${NEXT_VERSION}-macos-arm64.dmg"

echo "🎉 Release v$NEXT_VERSION 完了:"
gh release view "v$NEXT_VERSION"
```

### 9. Homebrew Cask の自動更新

`hummer98/homebrew-slaido` (`~/git/homebrew-slaido`) の `Casks/slaido.rb` を
新バージョン + sha256 で更新して push する。slaido は CI を持たないため、
ここをローカル `/release` 内で完結させる（mado は CI の update-tap.yml が担当）。

```bash
TAP_DIR="$HOME/git/homebrew-slaido"
ZIP_PATH="dist/slAIdo-v${NEXT_VERSION}-macos-arm64.zip"

if [ ! -d "$TAP_DIR" ]; then
  echo "⚠️ $TAP_DIR が無い。git clone https://github.com/hummer98/homebrew-slaido で取得してください。Cask 更新はスキップ。"
else
  SHA=$(shasum -a 256 "$ZIP_PATH" | awk '{print $1}')
  echo "📦 sha256: $SHA"

  git -C "$TAP_DIR" fetch origin main || { echo "❌ tap fetch 失敗"; exit 1; }
  git -C "$TAP_DIR" pull --ff-only origin main || { echo "❌ tap pull 失敗（分岐 or 権限）"; exit 1; }

  # version 行と sha256 行を置換。url 行は v#{version} 補間なので置換不要。
  sed -i '' -E "s/^(  version )\"[^\"]+\"/\1\"$NEXT_VERSION\"/" "$TAP_DIR/Casks/slaido.rb"
  sed -i '' -E "s/^(  sha256 )\"[0-9a-f]{64}\"/\1\"$SHA\"/" "$TAP_DIR/Casks/slaido.rb"

  # 検証
  grep -q "version \"$NEXT_VERSION\"" "$TAP_DIR/Casks/slaido.rb" \
    || { echo "❌ Cask version update 失敗"; exit 1; }
  grep -q "sha256 \"$SHA\"" "$TAP_DIR/Casks/slaido.rb" \
    || { echo "❌ Cask sha256 update 失敗"; exit 1; }
  grep -q 'v#{version}' "$TAP_DIR/Casks/slaido.rb" \
    || { echo "❌ url が v#{version} 補間形式でない"; exit 1; }

  git -C "$TAP_DIR" add Casks/slaido.rb
  if git -C "$TAP_DIR" diff --cached --quiet; then
    echo "ℹ️ Cask は既に最新（更新差分なし）"
  else
    git -C "$TAP_DIR" commit -m "chore: bump slaido to v$NEXT_VERSION"
    git -C "$TAP_DIR" push origin main
    echo "✅ Cask v$NEXT_VERSION を hummer98/homebrew-slaido に push"
  fi
fi

echo ""
echo "🍺 インストール:"
echo "    brew install --cask hummer98/slaido/slaido"
```

## 注意事項

### 署名・公証について

slaido は Apple Developer ID Application 証明書で署名し、Apple Notary Service で
公証 + staple 済みのバイナリを配布する。役割分担は mado と同じ:

- **codesign**: Electrobun が担当（`build.mac.codesign: true`）
- **notarize + staple**: fastlane が担当（`fastlane/Fastfile` の `notarize_app` lane）

ローカル実行時に必要な env（`~/git/.envrc` 親 direnv に共有、`slaido/.envrc` で `source_up`）:

| env | 用途 |
|---|---|
| `ELECTROBUN_DEVELOPER_ID` | codesign identity 文字列（mado と共有可） |
| `APP_STORE_CONNECT_API_KEY_KEY_ID` | notarize Key ID |
| `APP_STORE_CONNECT_API_KEY_ISSUER_ID` | notarize Issuer ID |
| `APP_STORE_CONNECT_API_KEY_KEY` | `.p8` の PEM 中身（改行込み） |

初回セットアップ手順は `docs/signing-setup.md` を参照。

### リリース失敗時のロールバック

途中でエラーが発生した場合の戻し方:

```bash
# タグを削除（ローカル + リモート）
git tag -d "v$NEXT_VERSION"
git push --delete origin "v$NEXT_VERSION"

# GitHub Release を削除
gh release delete "v$NEXT_VERSION" --yes

# version bump コミットを戻す（push 済みなら revert）
git revert HEAD
git push origin "$MAIN_BRANCH"
```

### 今後のタスク

- `.github/workflows/build-release.yml` で CI 化（mado パターン移植）
- `.github/workflows/update-tap.yml` で Cask 自動更新を CI 化（現状 /release 内のローカル処理）
- Mac App Store 配布（Distribution 証明書 + App Sandbox 対応）
- canary チャンネル運用
