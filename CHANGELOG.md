# Changelog

All notable changes to slAIdo will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-05-07

### Added

- interview-driven rubric 入力ステップを生成フローに導入。AI が動的に 3〜4 問を質問してスライドの方針を決める (T019)
- assistant メッセージとシード表示を Markdown (GFM) で描画 (marked + DOMPurify, T020)
- transcript メタデータを opencode session log に注入 (T016)
- 左ペインに seed / chat タブスイッチャーを追加
- OSS 公開ドキュメント (LICENSE / README / PRIVACY / CONTRIBUTING) (T017)
- 自動リリースパイプライン + Homebrew Cask 自動更新 (T018)

### Fixed

- PDF export で Chrome ヘッドレスが exit せず hang する問題を修正 (T021)

### Changed

- phase=seed のとき seed-input が左ペインの高さ全体を埋めるように (T022)
- e2e テストを interview flow + skip-link 経路の両方カバー、DEMO.md を新 UX に更新 (T023)

## [0.1.0] - 2026-05-01

### Added

- 初回リリース。Electrobun + reveal.js ベースの AI スライドジェネレーター
- OpenRouter BYOK / OpenCode SDK 連携
- HTML zip / PDF エクスポート
- macOS Developer ID codesign + 公証パイプライン（fastlane 経由）
