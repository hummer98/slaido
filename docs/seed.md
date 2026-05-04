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
2. 「スライドを生成」を押すと **インタビュー** が始まる (A004 採用)
   - 軽量モデル (Haiku 4.5) が シード本文を読み、3〜4 問でユーザーの狙いを聞き取る
   - 内部 6 軸 (聴衆 / 持ち時間 / 目的 / 成功条件 / トーン / 避けたい型) を埋める
   - 軸名はユーザーには見せない。質問はユーザーの語彙で出す
   - 「中断」を押すと seed mode に戻る
   - 過去に保存した rubric を流用したい場合は、シード入力欄の上部 `過去の rubric を流用`
     セレクタから選ぶと interview をスキップして rubric 編集 UI に進む
   - すぐに生成したいときは「スライドを生成」ボタン直下の `インタビューをスキップして生成`
     リンクで空 rubric のまま 4 へ進める
3. インタビューが終わると **rubric 編集 UI** が出る
   - 6 軸の値を編集 / 「このまま生成」/「保存して再利用」(preset 化) を選ぶ
   - 保存した rubric は次回以降、シード入力欄上部のセレクタから流用できる
4. Claude (opencode) が rubric を「## このスライドの前提条件」として seed の前に注入し、
   reveal.js HTML を生成 (Write ツールで `slides/index.html` を上書き)
5. 右ペインの iframe に即時反映
6. チャットで「3枚目のタイトルを変えて」などと指示
7. Claude が HTML を修正 → プレビュー更新
8. 完成したら HTML をエクスポート

## 視覚フィードバックループ（将来拡張）

Playwright で各スライドをスクリーンショット → Claude が画像を確認 → 修正、という完全自律ループも視野に入れる。

## 開発方針

- 開発はすべて AI エージェントが行う
- コーディング規約は mado（`~/git/mado`）に準拠
  - ドキュメント・コメント: 日本語
  - コード（変数名・関数名）: 英語
  - TypeScript strict mode
