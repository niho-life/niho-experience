import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { PersonMessageForm } from "./PersonMessageForm";

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

/** The words of 「◯◯さんにメッセージを送る」 (#589, owner decision 2026-11-13): like writing to a host, with no go-between in the text. */
describe("PersonMessageForm", () => {
  const html = renderToStaticMarkup(createElement(PersonMessageForm, { slug: "takuya", name: "高浜拓也" }));
  const words = text(html);

  it("asks for a message, a name and an address, and says where the reply comes", () => {
    expect(words).toContain("高浜拓也さんにメッセージを送る");
    expect(words).toContain("高浜拓也さんにメッセージ");
    expect(words).toContain("メッセージ");
    expect(words).toContain("お名前");
    expect(words).toContain("メールアドレス （返信はこのアドレスに届きます）");
    expect(html.match(/<input/g)).toHaveLength(2);
    expect(html.match(/<textarea/g)).toHaveLength(1);
    expect(html).not.toMatch(/type="(tel|password)"/);
  });

  it("never explains who handles it: no office, no relay", () => {
    for (const word of ["事務局", "NIHO が", "NIHOが", "NIHO から", "NIHOから", "中継", "仲介", "うかがいます", "代わりに"]) expect(words, word).not.toContain(word);
  });

  it("keeps what it needs off the URL and out of reach of the page's tracking: it posts to its own route only", () => {
    expect(html).not.toContain("href=");
    expect(html).not.toContain("action=");
  });
});
