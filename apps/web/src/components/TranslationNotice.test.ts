import { createElement, isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GuestBookingConversation } from "@niho-experience/experience-store";

/** The sentence under a traveler's message box when the message is translated for the host (#285, owner decision 2026-10-31). Synthetic data only. */
const state = vi.hoisted(() => ({ config: { guestQuestionsEnabled: true, guestMailEnabled: true, translationEnabled: false } }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/config", () => ({ get config() { return state.config; } }));

import GuestReplyPage from "@/app/(site)/questions/reply/page";
import { translationNoticeShown } from "@/lib/translation-notice";
import { AskHost } from "./AskHost";
import { BookingMessages } from "./BookingMessages";
import { GuestReply, ReplyWritingNote } from "./GuestReply";
import { TRANSLATION_NOTICE_TEXT, TranslationNotice } from "./TranslationNotice";

const SENTENCE = "Your message is translated into Japanese for the host with an AI service.";
const FACE = { initial: "S", image: null } as never;
const OPEN: GuestBookingConversation = { open: true, messages: [] };
const CLOSED: GuestBookingConversation = { open: false, messages: [] };

const askHost = (translationNotice?: boolean) => renderToStaticMarkup(createElement(AskHost, { slug: "sample-walk", target: "Sample Host", face: FACE, preview: false, nihoWebOrigin: "https://niho.example", ...(translationNotice === undefined ? {} : { translationNotice }) }));
const bookingMessages = (conversation: GuestBookingConversation, translationNotice?: boolean) =>
  renderToStaticMarkup(createElement(BookingMessages, { publicBookingId: "0f8fad5b-d9cb-469f-a165-708677289501", hostDisplayName: "Sample Host", timeZone: "Asia/Tokyo", conversation, ...(translationNotice === undefined ? {} : { translationNotice }) }));
const replyNote = (translationNotice: boolean) => renderToStaticMarkup(createElement(ReplyWritingNote, { hostDisplayName: "Sample Host", translationNotice }));

beforeEach(() => {
  state.config = { guestQuestionsEnabled: true, guestMailEnabled: true, translationEnabled: false };
});

describe("the translation notice", () => {
  it("is one sentence and a Privacy link that opens the notice in a new tab", () => {
    expect(TRANSLATION_NOTICE_TEXT).toBe(SENTENCE);
    const markup = renderToStaticMarkup(createElement(TranslationNotice));
    expect(markup).toContain(SENTENCE);
    expect(markup).toMatch(/<a[^>]*href="\/privacy"[^>]*target="_blank"[^>]*rel="noopener noreferrer"[^>]*>Privacy<span class="sr-only"> \(opens in a new tab\)<\/span><\/a>/);
  });

  it("is shown only when the guest's English really is translated: the setting and the mail job that runs it", () => {
    expect(translationNoticeShown({ translationEnabled: true, guestMailEnabled: true })).toBe(true);
    expect(translationNoticeShown({ translationEnabled: true, guestMailEnabled: false })).toBe(false);
    expect(translationNoticeShown({ translationEnabled: false, guestMailEnabled: true })).toBe(false);
    expect(translationNoticeShown({ translationEnabled: false, guestMailEnabled: false })).toBe(false);
  });
});

describe("under the guest's message boxes", () => {
  it("Ask the host shows it only when the server says so", () => {
    expect(askHost(true)).toContain(SENTENCE);
    expect(askHost(true)).toContain('href="/privacy"');
    expect(askHost(false)).not.toContain(SENTENCE);
    // Mock and preview pass nothing: no notice, so what the e2e suite sees is unchanged.
    expect(askHost()).not.toContain(SENTENCE);
    expect(askHost()).not.toContain("/privacy");
    // The sentence that was already there stays.
    expect(askHost(true)).toContain("Write in English. NIHO translates your question for Sample Host");
  });

  it("the reply page shows it only when the server says so", () => {
    expect(replyNote(true)).toContain(SENTENCE);
    expect(replyNote(false)).not.toContain(SENTENCE);
    expect(replyNote(false)).toContain("Write in English. Sample Host&#x27;s answer comes to your email. This link works for one reply.");
    expect(renderToStaticMarkup(createElement(GuestReply))).not.toContain(SENTENCE);
  });

  it("the booking page's message box shows it only when the server says so, and not once the booking takes no messages", () => {
    expect(bookingMessages(OPEN, true)).toContain(SENTENCE);
    expect(bookingMessages(OPEN, false)).not.toContain(SENTENCE);
    expect(bookingMessages(OPEN)).not.toContain(SENTENCE);
    expect(bookingMessages(OPEN)).toContain("Send message");
    // No box, so nothing is translated and nothing to say.
    expect(bookingMessages(CLOSED, true)).not.toContain(SENTENCE);
  });

  it("the reply page route passes the server's answer: off by default, on with translation and the mail job", () => {
    const notice = () => {
      const element = GuestReplyPage();
      expect(isValidElement(element)).toBe(true);
      return (element as { props: { translationNotice: boolean } }).props.translationNotice;
    };
    expect(notice()).toBe(false);
    state.config = { ...state.config, translationEnabled: true, guestMailEnabled: false };
    expect(notice()).toBe(false);
    state.config = { ...state.config, guestMailEnabled: true };
    expect(notice()).toBe(true);
  });
});
