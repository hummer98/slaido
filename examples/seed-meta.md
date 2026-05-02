# slAIdo — AI で作るスライドジェネレーター

## コンセプト

シードドキュメント（メモ・アウトライン・既存資料）を AI エージェントに渡すと、reveal.js ベースの HTML プレゼンテーションを生成・反復改善できるデスクトップアプリ。

## 名前の由来

`sl` + `AI` + `do` の合成語。英語の "slide" と日本語の "スライド"（su-ra-i-**do**）の両方に AI が埋め込まれている。表記は **slAIdo**、リポジトリ名は `slaido`。

## ターゲットユーザー

エンジニアではない一般ユーザー。Terminal を開かずに使えることが前提。

## 配布方針

- **理想**: Mac App Store
- **最低ライン**: Homebrew Cask（`brew install --cask slaido`）

## 技術スタック

- **reveal.js**: HTML/CSS 直書きで表現力が高く、`<section>` 単位で AI が編集しやすい
- **Electrobun**: バンドル ~14MB、起動 <50ms、App Store 親和性が高い
- **Bun + TypeScript**: AI エージェントが書きやすい型付き環境
- **OpenRouter (BYOK)**: macOS Keychain にユーザー自身のキーを保存し、API は直接叩かない

## アーキテクチャ

```
BrowserWindow (WKWebView)
├── 左ペイン: チャット UI（シード入力・対話履歴・修正指示）
└── 右ペイン: reveal.js プレビュー (iframe)

メインプロセス (Bun)
├── OpenCode SDK 経由で LLM を呼び出し
├── host-message で WebView と双方向通信
└── HTML zip / PDF エクスポート
```

## ワークフロー

1. シードドキュメントを左ペインに貼り付ける
2. 「スライドを生成」→ AI が reveal.js HTML を生成
3. 右ペインの iframe に即時反映
4. チャットで「3 枚目のタイトルを変えて」などと指示
5. AI が HTML を修正 → プレビュー更新
6. 完成したら HTML zip / PDF をエクスポート
