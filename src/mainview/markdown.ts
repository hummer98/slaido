/**
 * チャット / シード表示用の Markdown(GFM) レンダラ.
 *
 * marked.parse() の結果は **必ず** DOMPurify.sanitize() を通すこと.
 * assistant 出力には LLM 経由でプロンプトインジェクションされた
 * <script>/<iframe>/<img onerror=...> 等が混入する可能性があるため.
 *
 * - GFM (table / tasklist / strikethrough / autolink) を default ON
 * - breaks: true で改行を <br> に変換 (チャット UI として自然な挙動)
 * - シンタックスハイライト / KaTeX / mermaid は別タスク (task spec §5)
 */

import { marked } from "marked";
import DOMPurify from "dompurify";

marked.use({ gfm: true, breaks: true });

// DOMPurify v3 の default export はモジュール初期化時に `window` を取り込んで
// sanitize を生やす. ところがテスト環境 (bun test + happy-dom) では ESM の
// evaluation order の都合で dompurify モジュールが happy-dom register より
// 先に評価され, default export の sanitize が undefined のまま固まる.
// そこで sanitize 呼び出し時に sanitize の有無を確認し, 必要なら DOMPurify を
// factory として呼び直して当時の window を bind した instance を作り直す.
type Sanitizer = { sanitize: (html: string) => string };
let purifier: Sanitizer | null = null;

/**
 * テスト専用: 任意の Sanitizer instance を注入する.
 * 本番コードからは呼ばないこと. テスト側で local Window から作った DOMPurify
 * instance を渡せば, グローバル汚染なしに sanitize 動作を検証できる.
 */
export function __setPurifierForTest(p: Sanitizer): void {
  purifier = p;
}

function getPurifier(): Sanitizer {
  if (purifier && typeof purifier.sanitize === "function") return purifier;
  if (typeof (DOMPurify as unknown as Sanitizer).sanitize === "function") {
    purifier = DOMPurify as unknown as Sanitizer;
    return purifier;
  }
  const w = (globalThis as { window?: unknown }).window ?? globalThis;
  purifier = (DOMPurify as unknown as (root: unknown) => Sanitizer)(w);
  return purifier;
}

export function renderMarkdown(text: string): string {
  const html = marked.parse(text, { async: false }) as string;
  return getPurifier().sanitize(html);
}
