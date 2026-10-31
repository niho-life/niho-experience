import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ReplyDraftFields, type ReplyDraftControl } from "./ReplyDraftFields";

/** A reply with its English being written, as a correction starts. */
function draft(overrides: Partial<ReplyDraftControl> = {}): ReplyDraftControl {
  return {
    ids: { japanese: "ja", english: "en" },
    japanese: "ありがとうございました",
    english: "Thank you for coming.",
    madeFrom: null,
    editing: true,
    drafting: false,
    error: "",
    stale: false,
    hasEnglish: true,
    setJapanese: () => undefined,
    setEnglish: () => undefined,
    makeEnglish: async () => undefined,
    writeEnglish: () => undefined,
    clear: () => undefined,
    ...overrides,
  };
}

const render = (disabled?: boolean, control = draft()) =>
  renderToStaticMarkup(createElement(ReplyDraftFields, { draft: control, maxLength: 2000, englishLabel: "公開される英語", submitLabel: "返信を公開する", canSubmit: true, ...(disabled === undefined ? {} : { disabled }) }));

const textareas = (html: string) => [...html.matchAll(/<textarea\b[^>]*>/g)].map((match) => match[0]);
const buttons = (html: string) => [...html.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g)].map((match) => match[0]);
/** The attribute, not the `disabled:` classes every console button carries. */
const isDisabled = (button: string | undefined) => /<button\b[^>]*\sdisabled=""/.test(button ?? "");

describe("ReplyDraftFields while the reply is being sent (#108)", () => {
  it("keeps both fields and the buttons that change the draft editable by default", () => {
    const html = render();
    expect(textareas(html)).toHaveLength(2);
    for (const field of textareas(html)) expect(field).not.toContain("readOnly");
    expect(buttons(html).filter(isDisabled)).toEqual([]);
  });

  it("makes the Japanese and the English read-only and stops the English buttons while it is sent", () => {
    const html = render(true);
    for (const field of textareas(html)) expect(field).toContain('readOnly=""');
    // 英語を作り直す: the draft would be replaced under the host's eyes; 英語を直す is not shown while the English is edited.
    expect(isDisabled(buttons(html).find((button) => button.includes("英語を作り直す")))).toBe(true);
  });

  it("stops 英語を直す too when the English has not been opened for writing yet", () => {
    const html = render(true, draft({ editing: false }));
    expect(isDisabled(buttons(html).find((button) => button.includes("英語を直す")))).toBe(true);
    // The English shown is text, not a field.
    expect(textareas(html)).toHaveLength(1);
  });
});
