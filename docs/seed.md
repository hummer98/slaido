# slAIdo — プロジェクト構想・作業指示

## コンセプト

シードドキュメント（メモ・アウトライン・既存資料）を AI エージェントに渡すと、reveal.js ベースの HTML プレゼンテーションを生成・反復改善できるデスクトップアプリ。

## 名前の由来

`sl` + `AI` + `do` の合成語。英語の "slide" と日本語の "スライド"（su-ra-i-**do**）の両方に AI が埋め込まれている。表記は **slAIdo**、リポジトリ名は `slaido`。

## ターゲットユーザー

エンジニアではない一般ユーザー。Terminal を開かずに使えることが前提。

## 配布方針

- **理想**: Mac App Store
- **最低ライン**: Homebrew Cask（`brew install --cask slaido`）

## 技術スタック選定の経緯

### なぜ reveal.js か

- Marp は Markdown 行単位の編集になり AI との相性が悪い
- Google Slides API は外部サービス依存
- reveal.js は HTML/CSS 直書きで表現力が高く、外部依存なし
- `<section>` 単位で AI が編集できるため、意味的な粒度が適切

### なぜ Electrobun か

| 比較項目 | Electron | Electrobun | Swift |
|---------|----------|------------|-------|
| AI 開発適性 | ✓ TypeScript | ✓ TypeScript | △ |
| App Store | △ | ✓ | ✓ |
| バンドルサイズ | ~200MB | ~14MB | ネイティブ |
| 起動速度 | 2–5秒 | <50ms | ネイティブ |

Electron より App Store 親和性が高く、Tauri より TypeScript ネイティブで AI エージェントが書きやすい。

## アーキテクチャ

```
BrowserWindow (WKWebView)
├── 左ペイン: チャット UI
│     - シードドキュメント入力
│     - AI との対話履歴
│     - 修正指示の入力
└── 右ペイン: reveal.js プレビュー (iframe / srcdoc)

メインプロセス (Bun)
├── Claude API 呼び出し（スライド生成・修正）
├── host-message / executeJavascript で WebView と通信
└── ファイル読み書き（将来: スライド HTML の保存）
```

## ワークフロー

1. ユーザーがシードドキュメントを左ペインに貼り付ける
2. 「スライドを生成」→ Claude が reveal.js HTML を生成
3. 右ペインの iframe に即時反映
4. チャットで「3枚目のタイトルを変えて」などと指示
5. Claude が HTML を修正 → プレビュー更新
6. 完成したら HTML をエクスポート

## 視覚フィードバックループ（将来拡張）

Playwright で各スライドをスクリーンショット → Claude が画像を確認 → 修正、という完全自律ループも視野に入れる。

## 開発方針

- 開発はすべて AI エージェントが行う
- コーディング規約は mado（`~/git/mado`）に準拠
  - ドキュメント・コメント: 日本語
  - コード（変数名・関数名）: 英語
  - TypeScript strict mode
