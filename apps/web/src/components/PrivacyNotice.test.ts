import { createElement, isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/** The traveler privacy notice at /privacy (#285, owner decision 2026-10-31). Synthetic settings only. */
const state = vi.hoisted(() => ({ config: { siteUrl: "https://experience.example", privacyPolicyUrl: "" } }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/config", () => ({ get config() { return state.config; } }));

import PrivacyPage, { generateMetadata } from "@/app/(site)/privacy/page";
import { PrivacyNotice } from "./PrivacyNotice";

const POLICY = "https://policy.example/legal/privacy";
const html = (policyUrl = "") => renderToStaticMarkup(createElement(PrivacyNotice, { policyUrl }));
const text = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/&#x27;|&apos;/g, "'").replace(/\s+/g, " ");

beforeEach(() => {
  state.config = { siteUrl: "https://experience.example", privacyPolicyUrl: "" };
});

describe("the privacy notice", () => {
  it("has the page heading and one headed section for each thing a traveler wants to know", () => {
    const markup = html();
    expect(markup).toMatch(/<h1[^>]*>Privacy<\/h1>/);
    const headings = [...markup.matchAll(/<h2[^>]*>([^<]+)<\/h2>/g)].map((match) => match[1]);
    expect(headings).toEqual(["What we keep", "Why we use it", "Who sees or handles it", "How long we keep it", "Cookies", "Questions or requests"]);
    // Every section is a labelled region.
    expect(markup.match(/<section aria-labelledby="privacy-[a-z]+"/g)).toHaveLength(6);
  });

  it("says what is kept, who handles it, and for how long, as the code does it", () => {
    const words = text(html());
    expect(words).toContain("your name, your email address, your phone number if you give one, your note to the host, your answers to the booking questions");
    expect(words).toContain("The host never sees your email address.");
    expect(words).toContain("phone number, if you gave one, appears only on the host's page for your date");
    expect(words).toContain("we never see them");
    expect(words).toContain("Our email provider");
    expect(words).toContain("When translation is used");
    expect(words).toContain("Anthropic");
    expect(words).toContain("translate them into Japanese for the host");
    expect(words).toContain("not your name, email address or booking details");
    expect(words).toContain("deleted one year after the experience");
    expect(words).toContain("For a cancelled booking, that is one year after the cancellation");
    expect(words).toContain("a payment review, a refund or a cancellation request is still open, we keep them until it is settled");
    expect(words).toContain("Questions you ask before booking are deleted one year after the last message");
    expect(words).toContain("one strictly necessary cookie for each booking");
    expect(words).toContain("(HttpOnly)");
    expect(words).toContain("30 days after the experience");
    expect(words).toContain("reply to any booking email");
  });

  it("sends questions to the site's own booking help", () => {
    expect(html()).toMatch(/<a[^>]*href="\/help"[^>]*>Booking help<\/a>/);
  });

  it("links NIHO's privacy policy only when it is configured, in a new tab without a referrer", () => {
    expect(html()).not.toContain("NIHO privacy policy");
    expect(html()).not.toContain(POLICY);
    const markup = html(POLICY);
    expect(markup).toMatch(new RegExp(`<a[^>]*href="${POLICY.replaceAll("/", "\\/")}"[^>]*>NIHO privacy policy</a>`));
    expect(markup).toMatch(/target="_blank"/);
    expect(markup).toMatch(/rel="noopener noreferrer"/);
  });
});

describe("the /privacy page", () => {
  it("renders the notice with the configured policy link, and without it while the setting is empty", () => {
    const page = PrivacyPage();
    expect(isValidElement(page)).toBe(true);
    expect(renderToStaticMarkup(page)).not.toContain("NIHO privacy policy");
    state.config = { ...state.config, privacyPolicyUrl: POLICY };
    expect(renderToStaticMarkup(PrivacyPage())).toContain(`href="${POLICY}"`);
  });

  it("is titled Privacy, canonical on this site, and sets no robots of its own (the layout adds noindex while search publishing is off)", () => {
    const metadata = generateMetadata();
    expect(metadata.title).toBe("Privacy");
    expect(metadata.alternates?.canonical).toBe("https://experience.example/privacy");
    expect(metadata.robots).toBeUndefined();
    expect(metadata.description).toEqual(expect.any(String));
  });
});
