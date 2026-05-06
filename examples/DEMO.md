# slAIdo メタデモ — 録画台本

slAIdo 自身を slAIdo で紹介するデモ。所要 5〜7 分。

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

3 ステップ目で AI が 3〜4 問質問を返してくる。固定テンプレに当てはめずに deck ごとの rubric を作るのが slAIdo の特徴的な UX なので、録画では interview のやりとりも含めて見せる。

## デモシナリオ

| # | 操作 | 期待される画面 / 補足 |
|---|------|---------------------|
| 1 | `cd ~/git/slaido && bun run start` | 左ペインに空チャット、右ペインに空 reveal.js が表示される |
| 2 | `examples/seed-meta.md` の内容を全選択 → コピー → 左ペインに貼り付け | テキストエリアに seed の Markdown が入る |
| 3a | 「スライドを生成」を押す | 左ペインに最初の質問が表示される（聴衆・持ち時間・目的・成功条件・トーンなどから AI が選ぶ） |
| 3b | 質問に回答（例: 聴衆＝開発者、持ち時間＝5 分 LT、目的＝紹介、トーン＝カジュアル など 3〜4 往復） | 各回答後に次の質問または rubric edit へ遷移する |
| 3c | rubric edit 画面で内容を確認し「このまま生成」を押す | 右ペインで reveal.js が段階的に描画される（数秒〜十数秒） |
| 4 | 矢印キーまたは右ペインのナビでスライドを 1 枚ずつ確認 | 6〜8 枚程度のスライドが揃っている |
| 5 | 修正指示をチャットに投入: <br>**「タイトルスライドのサブタイトルを『Mac App Store ready』に変えて」** | 該当箇所のみが書き換わり、プレビューが自動更新される |
| 6 | 「HTML zip でエクスポート」を押す | 保存ダイアログ → `~/Desktop/slaido-demo.zip` |
| 7 | 「PDF でエクスポート」を押す | 保存ダイアログ → `~/Desktop/slaido-demo.pdf` |
| 8 | 録画を停止（Cmd+Ctrl+Esc） | `~/Desktop/slaido-demo.mov` 完成 |

### 短縮版（録画時間を抑えたい場合）

インタビューを省きたい場合、「スライドを生成」ボタンの直下にある「インタビューをスキップして生成」リンクを押すと、interview / rubric-edit を経由せず即生成に入る。短時間の録画や検証用途に。

## ナレーション例（任意）

- 起動直後: 「これが slAIdo です。左がチャット、右が reveal.js のプレビュー。」
- 貼り付け後: 「シードドキュメントを貼り付けて、生成ボタンを押すだけ。」
- 質問表示時: 「目的や聴衆を AI が聞いてくれます。固定テンプレに当てはめないので、deck ごとに最適化された rubric が作られます。」
- rubric edit 時: 「rubric は表示されているので、納得できなければ手で直してから生成できます。」
- 生成中: 「OpenRouter 経由でモデルがスライドを書いていきます。」
- 修正指示: 「気になる箇所はチャットで指示するとピンポイントで直してくれます。」
- エクスポート: 「完成したら HTML zip と PDF にエクスポートできます。」

## 失敗時のリカバリ

- **API キーモーダルが出てしまう**: Keychain にキーが入っていない、または `sk-or-` プレフィックスでない。`security find-generic-password -s dev.slaido.app -a openrouter -w` で確認。
- **右ペインが空のまま**: `~/Library/Logs/slAIdo/` または起動ターミナルのログを確認。OpenCode サーバの起動失敗が多い。
- **生成が途中で止まる**: OpenRouter のレート制限・残高切れ。アカウント設定を確認。
- **録画ファイルが空**: `screencapture -v` の権限（システム設定 → プライバシー → 画面収録）でターミナルアプリを許可。
