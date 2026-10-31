"use server";

import { nihoIdOrNull } from "@/lib/host/providers";
import { HOST_INVALID_INPUT_TEXT } from "./errors";
import { reportGuestReview as reportStoredReview, saveGuestReviewReply } from "./guest-reviews-server";
import type { HostActionResult } from "./payout";
import { REVIEW_REPLY_TEXT_LIMIT, REVIEW_REPORT_NOTE_LIMIT, REVIEW_REPORT_REASONS } from "./reviews";
import type { HostReview } from "./types";

/*
 * レビュー's writes to the experience DB (#108, docs/guest-reviews.md), as server actions. Arguments
 * come from the browser, so each is checked here; the store checks the rest and that the account
 * is the provider's OWNER (guest-reviews-server.ts).
 */

type Saved = { review: HostReview; revision: number };

const invalid = { ok: false, message: HOST_INVALID_INPUT_TEXT } as const;
const REVIEW_ID_LIMIT = 200;
const COMMAND_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A string from the browser, at most `max` characters long. */
function text(value: unknown, max: number): string | null {
  return typeof value === "string" && value.length <= max ? value : null;
}

function commandIdOrNull(value: unknown): string | null {
  return typeof value === "string" && COMMAND_ID.test(value) ? value : null;
}

/** 返信を公開する / 返信を直す: the English is required; the Japanese is empty when the host wrote the English directly. */
export async function publishGuestReviewReply(input: { providerId: string; reviewId: string; japanese: string; english: string; commandId: string; expectedRevision: number }): Promise<HostActionResult<Saved>> {
  const providerId = nihoIdOrNull(input?.providerId);
  const reviewId = text(input?.reviewId, REVIEW_ID_LIMIT);
  const japanese = text(input?.japanese, REVIEW_REPLY_TEXT_LIMIT);
  const english = text(input?.english, REVIEW_REPLY_TEXT_LIMIT);
  const commandId = commandIdOrNull(input?.commandId);
  const expectedRevision = input?.expectedRevision;
  if (!providerId || !reviewId || japanese === null || !english?.trim() || !commandId) return invalid;
  if (typeof expectedRevision !== "number" || !Number.isInteger(expectedRevision) || expectedRevision < 0) return invalid;
  return saveGuestReviewReply(providerId, reviewId, { japanese, english, commandId, expectedRevision });
}

/** NIHO に報告する: one of the reasons, and the host's word (may be empty). */
export async function reportGuestReview(input: { providerId: string; reviewId: string; reason: string; note: string; commandId: string }): Promise<HostActionResult<Saved>> {
  const providerId = nihoIdOrNull(input?.providerId);
  const reviewId = text(input?.reviewId, REVIEW_ID_LIMIT);
  const reason = REVIEW_REPORT_REASONS.find((item) => item.value === input?.reason)?.value ?? null;
  const note = text(input?.note, REVIEW_REPORT_NOTE_LIMIT);
  const commandId = commandIdOrNull(input?.commandId);
  if (!providerId || !reviewId || !reason || note === null || !commandId) return invalid;
  return reportStoredReview(providerId, reviewId, { reason, note, commandId });
}
