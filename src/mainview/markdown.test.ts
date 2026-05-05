/**
 * markdown.ts (renderMarkdown) のユニットテスト.
 *
 * DOMPurify は window/document を要求するため、本テストでは happy-dom の
 * **local Window** を作って DOMPurify(localWindow) で sanitizer instance を
 * 生成し, `__setPurifierForTest` でモジュールに注入する. これにより
 * `globalThis.fetch` / `window` / `document` を一切汚染しないため, 同じ
 * bun test process 内の他テスト (例: server-manager の real-binary テスト)
 * の fetch を happy-dom 版に置き換えてしまう事故を防げる.
 */
import { Window } from "happy-dom";
import createDOMPurify from "dompurify";
import { describe, expect, test } from "bun:test";
import { renderMarkdown, __setPurifierForTest } from "./markdown";

const localWindow = new Window();
const localPurifier = createDOMPurify(localWindow as unknown as Window & typeof globalThis);
__setPurifierForTest(localPurifier as unknown as { sanitize: (html: string) => string });

describe("renderMarkdown — GFM 要素の描画", () => {
  test("見出し (#, ##, ###)", () => {
    const html = renderMarkdown("# H1\n\n## H2\n\n### H3");
    expect(html).toContain("<h1");
    expect(html).toContain(">H1</h1>");
    expect(html).toContain("<h2");
    expect(html).toContain("<h3");
  });

  test("箇条書き (- / 1.)", () => {
    expect(renderMarkdown("- a\n- b")).toContain("<ul>");
    expect(renderMarkdown("- a\n- b")).toContain("<li>a</li>");
    expect(renderMarkdown("1. a\n2. b")).toContain("<ol>");
  });

  test("bold / italic / inline code", () => {
    const html = renderMarkdown("**bold** *italic* `code`");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<em>italic</em>");
    expect(html).toContain("<code>code</code>");
  });

  test("コードフェンス", () => {
    const html = renderMarkdown("```ts\nconst x = 1;\n```");
    expect(html).toContain("<pre>");
    expect(html).toContain("<code");
    expect(html).toContain("const x = 1;");
  });

  test("GFM table", () => {
    const md = "| a | b |\n|---|---|\n| 1 | 2 |";
    const html = renderMarkdown(md);
    expect(html).toContain("<table>");
    expect(html).toContain("<th>a</th>");
    expect(html).toContain("<td>1</td>");
  });

  test("GFM tasklist", () => {
    const html = renderMarkdown("- [x] done\n- [ ] todo");
    expect(html).toContain('type="checkbox"');
    expect(html).toContain("checked");
  });

  test("リンク", () => {
    const html = renderMarkdown("[hello](https://example.com)");
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain(">hello</a>");
  });

  test("breaks: true で改行が <br> になる", () => {
    const html = renderMarkdown("line1\nline2");
    expect(html).toContain("<br");
  });
});

describe("renderMarkdown — XSS サニタイズ", () => {
  test("<script> が除去される", () => {
    const html = renderMarkdown("hello <script>alert(1)</script>");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("alert(1)");
  });

  test("<img onerror=...> の onerror 属性が除去される", () => {
    const html = renderMarkdown("![x](javascript:alert(1))");
    expect(html.toLowerCase()).not.toContain("javascript:");
  });

  test("<iframe> が除去される", () => {
    const html = renderMarkdown('<iframe src="evil"></iframe>');
    expect(html).not.toContain("<iframe");
  });

  test("on* イベントハンドラ属性が除去される", () => {
    const html = renderMarkdown('<a href="x" onclick="evil()">x</a>');
    expect(html.toLowerCase()).not.toContain("onclick");
  });
});

describe("renderMarkdown — 通常テキスト", () => {
  test("プレーンテキストが <p> に包まれる", () => {
    const html = renderMarkdown("hello world");
    expect(html).toContain("hello world");
  });

  test("空文字列を渡しても落ちない", () => {
    expect(renderMarkdown("")).toBe("");
  });
});
