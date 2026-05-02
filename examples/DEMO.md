# slAIdo メタデモ — 録画台本

slAIdo 自身を slAIdo で紹介するデモ。所要 3〜5 分。

## 前提条件

- macOS（Apple Silicon）
- OpenRouter API キーが Keychain `dev.slaido.app/openrouter` に保存済み
- リポジトリは `bun install` 済、`bun run build:dev` が通る状態

### Keychain にキーを保存する（未保存の場合）

```bash
security add-generic-password -s dev.slaido.app -a openrouter -w 'sk-or-...' -U
```

確認:

```bash
security find-generic-password -s dev.slaido.app -a openrouter -w
```

## 録画コマンド

別ターミナルで先に実行（マイク音声込みで全画面録画。停止は Cmd+Ctrl+Esc または同 PID に SIGINT）:

```bash
screencapture -v -V default ~/Desktop/slaido-demo.mov
```

## デモシナリオ

| # | 操作 | 期待される画面 / 補足 |
|---|------|---------------------|
| 1 | `cd ~/git/slaido && bun run start` | 左ペインに空チャット、右ペインに空 reveal.js が表示される |
| 2 | `examples/seed-meta.md` の内容を全選択 → コピー → 左ペインに貼り付け | テキストエリアに seed の Markdown が入る |
| 3 | 「スライドを生成」ボタンを押す | 右ペインで reveal.js が段階的に描画される（数秒〜十数秒） |
| 4 | 矢印キーまたは右ペインのナビでスライドを 1 枚ずつ確認 | 6〜8 枚程度のスライドが揃っている |
| 5 | 修正指示をチャットに投入: <br>**「タイトルスライドのサブタイトルを『Mac App Store ready』に変えて」** | 該当箇所のみが書き換わり、プレビューが自動更新される |
| 6 | 「HTML zip でエクスポート」を押す | 保存ダイアログ → `~/Desktop/slaido-demo.zip` |
| 7 | 「PDF でエクスポート」を押す | 保存ダイアログ → `~/Desktop/slaido-demo.pdf` |
| 8 | 録画を停止（Cmd+Ctrl+Esc） | `~/Desktop/slaido-demo.mov` 完成 |

## ナレーション例（任意）

- 起動直後: 「これが slAIdo です。左がチャット、右が reveal.js のプレビュー。」
- 貼り付け後: 「シードドキュメントを貼り付けて、生成ボタンを押すだけ。」
- 生成中: 「OpenRouter 経由でモデルがスライドを書いていきます。」
- 修正指示: 「気になる箇所はチャットで指示するとピンポイントで直してくれます。」
- エクスポート: 「完成したら HTML zip と PDF にエクスポートできます。」

## 失敗時のリカバリ

- **API キーモーダルが出てしまう**: Keychain にキーが入っていない、または `sk-or-` プレフィックスでない。`security find-generic-password -s dev.slaido.app -a openrouter -w` で確認。
- **右ペインが空のまま**: `~/Library/Logs/slAIdo/` または起動ターミナルのログを確認。OpenCode サーバの起動失敗が多い。
- **生成が途中で止まる**: OpenRouter のレート制限・残高切れ。アカウント設定を確認。
- **録画ファイルが空**: `screencapture -v` の権限（システム設定 → プライバシー → 画面収録）でターミナルアプリを許可。
