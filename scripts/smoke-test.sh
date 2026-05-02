#!/bin/bash
# slAIdo スモークテスト: ビルド済み .app の launcher を起動して
#   - Notarized Developer ID 署名が通っていること（spctl + codesign + stapler）
#   - launcher が exit code 0 でアプリ本体を spawn できること
# を検証する。
#
# 使い方: scripts/smoke-test.sh [app_path]
#   例: scripts/smoke-test.sh build/stable-macos-arm64/slAIdo.app
#   省略時は build/stable-macos-arm64/slAIdo.app を使用。
#
# 注: launcher は Electrobun self-extractor なので bun プロセスを spawn 後に
#     自身は exit する。生存確認ではなく log 出力で成否を判定する。
set -euo pipefail

APP_PATH="${1:-build/stable-macos-arm64/slAIdo.app}"
LAUNCHER="$APP_PATH/Contents/MacOS/launcher"

if [ ! -x "$LAUNCHER" ]; then
  echo "❌ launcher が見つからない: $LAUNCHER (bun run build:prod を先に実行)" >&2
  exit 1
fi

# 署名検証。`spctl --assess` で「Notarized Developer ID」を検出した場合のみ
# 詳細検証を行い、それ以外は unsigned / dev ビルドとしてスキップ。
if spctl --assess --type execute --verbose=2 "$APP_PATH" 2>&1 | grep -q "Notarized Developer ID"; then
  echo "🔐 Notarized Developer ID 署名を検出。検証を実行..."
  if ! codesign --verify --deep --strict --verbose=2 "$APP_PATH" 2>&1; then
    echo "❌ codesign 検証失敗"
    exit 1
  fi
  if ! stapler validate "$APP_PATH" 2>&1; then
    echo "❌ stapler validate 失敗（notarize が未完了 or staple されていない）"
    exit 1
  fi
  echo "✅ 署名・staple 検証 OK"
else
  echo "ℹ️  Notarized Developer ID 署名なし（unsigned / dev ビルド）。署名検証はスキップ。"
fi

# launcher を 5 秒だけ起動して logger 出力を確認する。
# slaido は ~/Library/Logs/slAIdo/main.log にログを書くので、
# 起動シーケンスのキーイベントが現れるかをチェックする。
LOG_FILE="$HOME/Library/Logs/slAIdo/main.log"
LOG_BEFORE=$(wc -l < "$LOG_FILE" 2>/dev/null || echo 0)

echo "🚀 launcher を起動して 8 秒後に kill..."
"$LAUNCHER" >/tmp/slaido-smoke-stdout.log 2>/tmp/slaido-smoke-stderr.log &
LAUNCHER_PID=$!
sleep 8
kill "$LAUNCHER_PID" 2>/dev/null || true
pkill -f "stable-macos-arm64/slAIdo.app" 2>/dev/null || true
sleep 1

LOG_AFTER=$(wc -l < "$LOG_FILE" 2>/dev/null || echo 0)
NEW_LINES=$((LOG_AFTER - LOG_BEFORE))

if [ "$NEW_LINES" -gt 0 ] && \
   tail -n "$NEW_LINES" "$LOG_FILE" 2>/dev/null | grep -qE "paths_resolved|webview_ready"; then
  echo "✅ smoke test OK (logger emitted $NEW_LINES new lines)"
  exit 0
else
  echo "❌ smoke test failed: logger に起動イベントが出ていない"
  echo "--- last main.log lines ---"
  tail -n 20 "$LOG_FILE" 2>/dev/null || echo "(no log)"
  echo "--- launcher stdout ---"
  cat /tmp/slaido-smoke-stdout.log 2>/dev/null | tail -n 20
  echo "--- launcher stderr ---"
  cat /tmp/slaido-smoke-stderr.log 2>/dev/null | tail -n 20
  exit 1
fi
