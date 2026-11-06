import { describe, expect, it } from "vitest";
import {
  canSaveHostBio,
  draftFromState,
  hostBioCount,
  hostBioFieldError,
  hostBioMutationOutcome,
  hostBioPublicationNote,
  hostBioSaveBody,
  hostBioTranslationOutcome,
  parseHostBioLoad,
  parseHostBioState,
  resolveUnknownResult,
  savedMatchesDraft,
  withEnglish,
  withJapanese,
  type HostBioState,
} from "./host-bio-form-model";

const CONSENT = "host-bio-consent-v1";
const empty: HostBioState = { version: 0, bioJa: null, bioEn: null, englishConfirmed: false, consentVersion: null, updatedAtUtc: null };
const saved: HostBioState = { version: 3, bioJa: "鎌倉で茶道を教えています。", bioEn: "I teach tea ceremony in Kamakura.", englishConfirmed: true, consentVersion: CONSENT, updatedAtUtc: "2026-11-06T00:00:00.000Z" };

describe("host bio form model", () => {
  it("parses exact server states only", () => {
    expect(parseHostBioState(empty)).toEqual(empty);
    expect(parseHostBioState(saved)).toEqual(saved);
    expect(parseHostBioState({ ...saved, providerId: "x" })).toBeNull();
    expect(parseHostBioState({ ...empty, bioJa: "x" })).toBeNull();
    expect(parseHostBioState({ ...saved, englishConfirmed: true, bioEn: null })).toBeNull();
    expect(parseHostBioState({ ...saved, updatedAtUtc: "yesterday" })).toBeNull();
    expect(parseHostBioLoad({ hostBio: empty, consentVersion: CONSENT })).toEqual({ hostBio: empty, consentVersion: CONSENT });
    expect(parseHostBioLoad({ hostBio: empty })).toBeNull();
  });

  it("starts from the saved text and checks English only while it is published", () => {
    expect(draftFromState(saved)).toEqual({ bioJa: saved.bioJa, bioEn: saved.bioEn, englishChecked: true });
    expect(draftFromState({ ...saved, englishConfirmed: false }).englishChecked).toBe(false);
    expect(draftFromState(empty)).toEqual({ bioJa: "", bioEn: "", englishChecked: false });
  });

  it("takes the English confirmation away when the Japanese changes, and then sends no English", () => {
    const draft = draftFromState(saved);
    expect(withJapanese(draft, saved.bioJa!)).toBe(draft);
    const changed = withJapanese(draft, "鎌倉で茶道を20年教えています。");
    expect(changed.englishChecked).toBe(false);
    expect(changed.bioEn).toBe(saved.bioEn);
    expect(hostBioSaveBody(changed, saved, CONSENT)).toEqual({ bioJa: "鎌倉で茶道を20年教えています。", bioEn: null, expectedVersion: 3, consentVersion: CONSENT });
    expect(hostBioSaveBody({ ...changed, englishChecked: true }, saved, CONSENT).bioEn).toBe(saved.bioEn);
    expect(hostBioSaveBody({ bioJa: "紹介", bioEn: "", englishChecked: true }, empty, CONSENT)).toEqual({ bioJa: "紹介", bioEn: null, expectedVersion: null, consentVersion: CONSENT });
  });

  it("takes the English confirmation away when the English can no longer be confirmed, so Save is not blocked by a hidden check", () => {
    const draft = draftFromState(saved);
    expect(withEnglish(draft, saved.bioEn!)).toBe(draft);
    // The scenario of the review: a confirmed English is emptied. The check is gone, and a Japanese-only bio can be saved.
    const emptied = withEnglish(draft, "");
    expect(emptied).toEqual({ bioJa: saved.bioJa, bioEn: "", englishChecked: false });
    expect(canSaveHostBio(draft, true, false)).toBe(true);
    expect(canSaveHostBio({ ...draft, bioEn: "" }, true, false)).toBe(false);
    expect(canSaveHostBio(emptied, true, false)).toBe(true);
    expect(hostBioSaveBody(emptied, saved, CONSENT).bioEn).toBeNull();
    expect(withEnglish(draft, "  \r\n").englishChecked).toBe(false);
    expect(withEnglish(draft, "a".repeat(1501)).englishChecked).toBe(false);
    expect(withEnglish(draft, "bad\u0007text").englishChecked).toBe(false);
    // An edit that stays usable keeps the host's check; an unchecked English stays unchecked.
    expect(withEnglish(draft, "I teach tea ceremony in Kamakura and Tokyo.").englishChecked).toBe(true);
    expect(withEnglish({ ...draft, englishChecked: false }, "Another intro.").englishChecked).toBe(false);
  });

  it("counts saved characters and explains over-long or controlled text", () => {
    expect(hostBioCount("  𠮷野家\r\n", "ja")).toEqual({ length: 3, limit: 600, remaining: 597, over: false });
    expect(hostBioCount("あ".repeat(601), "ja").over).toBe(true);
    expect(hostBioFieldError("あ".repeat(601), "ja")).toMatch(/600文字以内/);
    expect(hostBioFieldError("タ\tブ", "ja")).toMatch(/制御文字/);
    expect(hostBioFieldError("", "ja")).toBeNull();
    expect(hostBioFieldError("a".repeat(1501), "en")).toMatch(/1500文字以内/);
  });

  it("allows saving only with consent, a valid Japanese text and (when checked) a valid English one", () => {
    const draft = { bioJa: "紹介", bioEn: "", englishChecked: false };
    expect(canSaveHostBio(draft, true, false)).toBe(true);
    expect(canSaveHostBio(draft, false, false)).toBe(false);
    expect(canSaveHostBio(draft, true, true)).toBe(false);
    expect(canSaveHostBio({ ...draft, bioJa: " " }, true, false)).toBe(false);
    expect(canSaveHostBio({ ...draft, englishChecked: true, bioEn: "a".repeat(1501) }, true, false)).toBe(false);
    expect(canSaveHostBio({ ...draft, englishChecked: true, bioEn: "Intro" }, true, false)).toBe(true);
  });

  it("says when the saved English is not published", () => {
    expect(hostBioPublicationNote(empty)).toMatch(/まだ公開されていません/);
    expect(hostBioPublicationNote(saved)).toMatch(/日本語と英語/);
    expect(hostBioPublicationNote({ ...saved, englishConfirmed: false })).toMatch(/英語は.*まだ公開されていません/);
    expect(hostBioPublicationNote({ ...saved, bioEn: null, englishConfirmed: false })).toMatch(/英語はまだ公開されていません/);
  });

  it("classifies save results; unknown results are never treated as saved", () => {
    expect(hostBioMutationOutcome(200, { hostBio: saved })).toEqual({ kind: "CONFIRMED", state: saved });
    expect(hostBioMutationOutcome(200, { hostBio: { ...saved, extra: 1 } })).toEqual({ kind: "UNKNOWN" });
    expect(hostBioMutationOutcome(200, null)).toEqual({ kind: "UNKNOWN" });
    expect(hostBioMutationOutcome(401, null)).toEqual({ kind: "AUTH_REJECTED" });
    expect(hostBioMutationOutcome(403, null)).toEqual({ kind: "AUTH_REJECTED" });
    expect(hostBioMutationOutcome(409, null)).toEqual({ kind: "CONFLICT" });
    expect(hostBioMutationOutcome(422, null)).toEqual({ kind: "REJECTED" });
    expect(hostBioMutationOutcome(502, null)).toEqual({ kind: "UNKNOWN" });
    expect(hostBioMutationOutcome(503, null)).toEqual({ kind: "UNKNOWN" });
  });

  it("accepts only a usable English draft", () => {
    expect(hostBioTranslationOutcome(200, { bioEn: "Intro" })).toEqual({ kind: "DRAFT", bioEn: "Intro" });
    expect(hostBioTranslationOutcome(200, { bioEn: "a".repeat(1501) })).toEqual({ kind: "FAILED" });
    expect(hostBioTranslationOutcome(200, { bioEn: "" })).toEqual({ kind: "FAILED" });
    expect(hostBioTranslationOutcome(503, { error: { code: "TRANSLATION_UNAVAILABLE" } })).toEqual({ kind: "FAILED" });
    expect(hostBioTranslationOutcome(401, null)).toEqual({ kind: "AUTH_REJECTED" });
  });

  it("tells after an unknown result whether the host's text was saved", () => {
    expect(savedMatchesDraft(saved, { bioJa: ` ${saved.bioJa}\r\n`, bioEn: saved.bioEn!, englishChecked: true })).toBe(true);
    expect(savedMatchesDraft(saved, { bioJa: saved.bioJa!, bioEn: saved.bioEn!, englishChecked: false })).toBe(false);
    expect(savedMatchesDraft({ ...saved, bioEn: null, englishConfirmed: false }, { bioJa: saved.bioJa!, bioEn: "x", englishChecked: false })).toBe(true);
    expect(savedMatchesDraft(empty, { bioJa: "紹介", bioEn: "", englishChecked: false })).toBe(false);
  });

  it("judges an unknown withdrawal by the bio being gone, and an unknown save by the saved text", () => {
    const draft = draftFromState(saved);
    // Save: unchanged behaviour.
    expect(resolveUnknownResult("PUT", saved, draft)).toBe("SAVED");
    expect(resolveUnknownResult("PUT", empty, draft)).toBe("NOT_SAVED");
    // Withdrawal that reached the database: the state is empty and differs from the draft. Judged like a save this is
    // "not saved, save again", which would publish the withdrawn text again.
    expect(savedMatchesDraft(empty, draft)).toBe(false);
    expect(resolveUnknownResult("DELETE", empty, draft)).toBe("WITHDRAWN");
    // Withdrawal that failed: the original bio is still there and equals the draft. Judged like a save this is
    // "saved", which would hide that the withdrawal did not happen.
    expect(savedMatchesDraft(saved, draft)).toBe(true);
    expect(resolveUnknownResult("DELETE", saved, draft)).toBe("NOT_WITHDRAWN");
    expect(resolveUnknownResult("DELETE", { ...saved, version: 4 }, draft)).toBe("NOT_WITHDRAWN");
  });
});
