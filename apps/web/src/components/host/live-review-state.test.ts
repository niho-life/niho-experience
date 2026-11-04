import { describe, expect, it } from "vitest";
import type { HostReview } from "@/host/types";
import { replySignature, reportSignature, reviewAttempt, withRevision, withReviewTranslation, withSavedReview } from "./live-review-state";

const review = (id: string, english: string | null = null): HostReview => ({
  id,
  experienceId: "tea",
  bookingId: "NB-SAMPLE",
  sessionDate: "2026-10-31",
  reviewer: { name: "Sample Guest", country: "" },
  rating: 5,
  tags: [],
  body: { original: "Lovely.", language: "en", translation: null },
  privateNote: null,
  writtenAt: "2026-10-31T10:00",
  status: "published",
  publishedAt: "2026-10-31T10:00",
  reply: english ? { japanese: "", english, publishedAt: "2026-10-31T11:00", editedAt: null } : null,
  report: null,
});

describe("live review state", () => {
  it("keeps the command id while the same reply or report is tried again, and takes a new one for anything else", () => {
    let next = 0;
    const newId = () => `command-${++next}`;
    const first = reviewAttempt(undefined, replySignature("r1", { japanese: "ありがとう", english: "Thanks" }), newId);
    expect(first.commandId).toBe("command-1");
    expect(reviewAttempt(first, replySignature("r1", { japanese: "ありがとう", english: "Thanks" }), newId)).toBe(first);
    expect(reviewAttempt(first, replySignature("r1", { japanese: "ありがとう", english: "Thanks!" }), newId).commandId).toBe("command-2");
    expect(reviewAttempt(first, replySignature("r2", { japanese: "ありがとう", english: "Thanks" }), newId).commandId).toBe("command-3");
    // A report is never the reply's command, even with the same words.
    expect(replySignature("r1", { japanese: "other", english: "" })).not.toBe(reportSignature("r1", "other", ""));
    const reported = reviewAttempt(undefined, reportSignature("r1", "untrue", ""), newId);
    expect(reviewAttempt(reported, reportSignature("r1", "untrue", ""), newId)).toBe(reported);
    expect(reviewAttempt(reported, reportSignature("r1", "untrue", "Synthetic note"), newId).commandId).toBe("command-5");
  });

  it("puts the review the store answered in place and keeps its reply revision for the next correction", () => {
    const list = [review("r1"), review("r2")];
    const saved = review("r2", "Thank you!");
    expect(withSavedReview(list, saved)).toEqual([list[0], saved]);
    expect(withSavedReview(list, review("r3", "Unknown"))).toEqual(list);
    const revisions = { r1: 0, r2: 0 };
    expect(withRevision(revisions, "r2", 1)).toEqual({ r1: 0, r2: 1 });
    expect(revisions).toEqual({ r1: 0, r2: 0 });
  });

  it("applies only a translation of the same original, retaining stale reply metadata for CAS", () => {
    const revisions = { r1: 3, r2: 1 };
    const other = review("r1", "Other reply");
    const opened = { ...review("r2", "Reply when the draft opened"), report: { at: "2026-10-31T12:00", reason: "untrue" as const } };
    const fromStore = {
      ...review("r2", "Newer reply from another screen"),
      body: { original: "Lovely.", language: "en" as const, translation: "素敵でした。" },
      report: { at: "2026-10-31T13:00", reason: "personal" as const },
    };

    const patched = withReviewTranslation([other, opened], fromStore);
    expect(patched[0]).toBe(other);
    expect(patched[1]).toEqual({ ...opened, body: { ...opened.body, translation: "素敵でした。" } });
    expect(patched[1]?.reply).toBe(opened.reply);
    expect(patched[1]?.report).toBe(opened.report);
    expect(revisions).toEqual({ r1: 3, r2: 1 });

    expect(withReviewTranslation([opened], { ...fromStore, body: { ...fromStore.body, original: "Changed original" } })).toEqual([opened]);
    expect(withReviewTranslation([opened], { ...fromStore, id: "unknown" })).toEqual([opened]);
    expect(withReviewTranslation([opened], { ...fromStore, body: { ...fromStore.body, translation: null } })).toEqual([opened]);
  });
});
