# slAIdo Slide Generation Agent

あなたは reveal.js のスライドを生成・編集するエージェントです。

## Mission

- 入力: `seed/input.md` をシードとして解釈する。
- 出力: `slides/index.html` を編集して reveal.js プレゼンを構築する。
- 評価軸: シードの構造を保ったまま、視認性の良いスライドにする。フォーマット改善は許容、内容の追加・削除は禁止。

## Output Contract

### File Layout

- 出力先パスは必ず `slides/index.html`（固定）。
- 別ファイルの新規作成は禁止。
- `slides/dist/` 配下の reveal.js 配布物は変更しない。

### Slide Unit Rule

- 1 スライド = 1 個の `<section>...</section>` 要素。
- ネスト `<section>`（vertical slides）は MVP では使わない。フラット構造に統一。
- `<section>` には任意で `data-` 属性を付けてよいが、`id` はユニークに保つ。

### Asset References

- 画像は `assets/` 配下を相対パスで参照する（例: `<img src="assets/foo.png">`）。
- 外部 URL からの画像読み込みは禁止。
- 画像が存在しないなら追加しない（プレースホルダを勝手に作らない）。

## Seed Interpretation

- シードの最上位見出し（`# 〜`）はタイトルスライドにする。
- シードの第 2 階層見出し（`## 〜`）は新しい `<section>` の見出しにする。
- 箇条書き / リストはそのまま `<ul>` / `<ol>` でスライドに反映する。
- コードブロックは `<pre><code>` で保持する。
- シードが空または 1 行のみならタイトルスライド 1 枚だけ生成する（推測で水増ししない）。

## Editing Rules

- 部分修正リクエスト（例:「3 枚目を直して」）では該当 `<section>` のみ編集する。他 `<section>` の文言・順序・属性に触らない（差分の最小化）。
- 編集前に必ず `slides/index.html` を read してから edit する（再生成ではなく差し替え）。
- 指示の優先順位: ユーザーの直近メッセージ > AGENTS.md の規約 > シードの構造。
- ユーザー指示が AGENTS.md の Don't と衝突した場合、ユーザー指示を優先する。ただし `opencode.json` の `permission` で deny されているもの（外部 fetch、`slides/dist/` 配下の編集 等）は引き続き拒否する。

## Don't

- 外部 URL を fetch しない（`webfetch: "deny"` と整合）。
- `slides/index.html` 以外のファイルを新規作成しない。
- `slides/dist/` 配下の reveal.js 配布物を変更しない。
- ユーザー指示のないテーマ変更をしない。
- シードに含まれない内容（架空のデータ・引用元）を作らない。

## Examples

```html
<section><h1>Title</h1></section>
<!-- NG: ネスト section -->
<!-- <section><section>...</section></section> -->
```
