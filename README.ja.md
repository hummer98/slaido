<!-- TODO: assets/icon.svg を作成して差し込む -->
<p align="center">
  <img src="./assets/icon.svg" alt="slAIdo" width="180" />
</p>

<p align="center">
  <a href="./README.md">English</a>
</p>

# slAIdo

> シードドキュメントを渡すと、AI エージェントが reveal.js のスライドを生成・反復改善してくれる macOS デスクトップアプリ。

<!-- TODO: docs/images/screenshot.png を撮影 -->

## なぜ作ったか

世の中のスライドツールは「人間がスライドを書く」前提で作られています。AI エージェントと作業するなら前提は逆で、**素材（メモ・アウトライン・既存資料）を渡してデッキ自体を会話で育てたい**。

既存ツールは噛み合いませんでした。

- **Marp** は Markdown の行単位編集が中心。AI に「3 枚目だけ直して」と頼んでも diff がノイジーになり、モデルが掴みやすい意味的な単位がありません。
- **Google Slides API** は外部サービスと Google アカウントへの依存が大きく、エンドユーザーの導入摩擦になり、オフライン用途も諦めることになります。
- **reveal.js** を手書きするのは人間にはつらい一方、AI に HTML を直接書かせると驚くほど相性が良い。`<section>` 単位で編集できるので「3 枚目を書き換えて」が他のスライドを壊さずに通ります。

slAIdo はこの観察を中心に設計しました。エージェントは reveal.js の `<section>` を並べた 1 つの `index.html` を編集し、デスクトップアプリがライブプレビューと、チャット指示のモデルへのルーティングを担当します。

ターゲットは非エンジニア。Terminal を開かずに使えることが前提です。Homebrew で入れてダブルクリックで起動、シードドキュメントを貼り付けて反復するだけで使えます。

## 特長

- **reveal.js 出力** — スライドの実体は単一の HTML 内の `<section>` 要素。AI が編集する対象であると同時に、必要なら人間が手で直すこともできます
- **OpenCode SDK 連携** — LLM 呼び出しは [OpenCode](https://opencode.ai) のエージェントランタイム経由。薄いチャットラッパーではなく、本物のコーディングエージェントのツールセットがモデルに渡ります
- **OpenRouter BYOK** — OpenRouter のキーは macOS Keychain (`dev.slaido.app`) に保存。プレーンテキストの設定ファイルには書きません
- **Anthropic prompt caching** — テンプレートや既存スライド HTML など繰り返し送る文脈を provider 側でキャッシュし、反復のコストを抑えます
- **HTML zip / PDF エクスポート** — 自己完結する `slides.zip` として配布する、または reveal.js の print モードで PDF にレンダリングする 2 経路
- **署名・公証済み** — Apple Developer ID で codesign し Apple Notary Service で公証済み。Gatekeeper の回避操作なしで起動できます

## インストール

推奨は Homebrew Cask 経由です (macOS Apple Silicon)。

```bash
brew install --cask hummer98/slaido/slaido
```

`/Applications/slAIdo.app` が配置されます。Apple Developer ID で署名・公証済みのため、`xattr -d com.apple.quarantine` や右クリック→開く といった回避操作は不要です。

更新する場合:

```bash
brew update && brew upgrade --cask slaido
```

### 手動インストール (Homebrew を使わない場合)

[v0.1.0 リリースページ](https://github.com/hummer98/slaido/releases/tag/v0.1.0) から `slAIdo-v0.1.0-macos-arm64.zip` をダウンロードし、解凍して `slAIdo.app` を `/Applications` に配置してください。

リリースビルドは tag push (`v*.*.*`) を契機に GitHub Actions が自動でビルド・署名・公証・publish します。Homebrew Cask (`hummer98/slaido`) も後続の workflow で自動更新されるため、新バージョン公開後すぐに `brew upgrade --cask slaido` で取得できます。CI パイプラインの全体像は [`docs/release-automation.md`](./docs/release-automation.md) を参照してください。

## 使い方

1. `/Applications` または Spotlight から **slAIdo** を起動します。
2. 初回起動時に OpenRouter API キーの入力を求められるので貼り付けます (macOS Keychain に保存されます)。
3. 左ペインに**シードドキュメント** (メモ・アウトライン・既存資料) を貼り付けて *Generate* を押します。
4. 右ペインに reveal.js のライブプレビューが表示されます。「3 枚目を 2 カラム比較に」「イントロを短く」など、チャットで指示して反復していきます。
5. 完成したらエクスポートします:
   - **HTML zip** — どこにでもホストできる自己完結型ディレクトリ
   - **PDF** — reveal.js の print モードでレンダリング

シードドキュメントの例は [`examples/seed-meta.md`](./examples/seed-meta.md) を参照してください。

## 仕組み

slAIdo は [Electrobun](https://electrobun.dev) — [Bun](https://bun.sh) と macOS ネイティブ WKWebView を組み合わせた軽量なネイティブシェル — の上に構築されています。Bun プロセスが [OpenCode SDK](https://opencode.ai) のセッションとファイル I/O を所有し、WebView 側は左に Chat UI、右に iframe で読み込んだ reveal.js デッキを表示します。チャット指示とスライド更新は host-message bridge で双方向にやりとりされ、エージェントはディスク上の実際の HTML ファイルを編集し、プレビューはその場でリロードされます。

## 開発

前提: macOS Apple Silicon (`arm64`)、[Bun](https://bun.sh) 1.0 以上。

```bash
bun install              # 依存インストール
bun start                # dev 起動 (Electrobun dev モード)
bun test                 # ユニットテスト (bun:test)
bun test:e2e             # Electrobun 統合テスト
```

リリースビルドの署名・公証は Electrobun + fastlane で完結します。詳細は [`docs/signing-setup.md`](./docs/signing-setup.md)。リリースパイプライン全体（CI ビルド + Cask 更新）は [`docs/release-automation.md`](./docs/release-automation.md)、バージョンごとの履歴は [`CHANGELOG.md`](./CHANGELOG.md) を参照してください。

## プライバシー

slAIdo はローカルで動作し、通信先は指定した LLM プロバイダ (OpenRouter およびその先のモデルプロバイダ) のみです。テレメトリは収集しません。何がどこに保存されるかの詳細は [PRIVACY.md](./PRIVACY.md) を参照してください。

## ライセンス

MIT — [LICENSE](./LICENSE) を参照。

## コントリビューション

Issue-first でお願いします。非自明な変更は PR の前にまず Issue を立ててスコープを相談させてください。詳細は [CONTRIBUTING.md](./CONTRIBUTING.md)。
