export type PublicationNextAction = "SAVE" | "SCHEDULE" | "PRICING" | "MANUSCRIPT" | "PHOTOS" | "SUPPORT" | "PAYMENT_CONSENT" | "EXTERNAL" | "PUBLISH" | "LIVE";

export function publicationNextAction(input: {
  readonly dirty: boolean;
  readonly blockers: readonly string[];
  readonly published: boolean;
}): PublicationNextAction {
  if (input.dirty) return "SAVE";
  const blockers = new Set(input.blockers);
  if (blockers.has("SCHEDULE_REQUIRED")) return "SCHEDULE";
  if (blockers.has("PRICE_REQUIRED") || blockers.has("CANCELLATION_TERMS_REQUIRED")) return "PRICING";
  if (blockers.has("MANUSCRIPT_REQUIRED") || blockers.has("PUBLIC_CONTENT_INVALID")) return "MANUSCRIPT";
  if (blockers.has("PHOTOS_REQUIRED")) return "PHOTOS";
  if (blockers.has("SUPPORT_CONSENT_REQUIRED")) return "SUPPORT";
  if (blockers.has("PAYMENT_REUSE_CONSENT_REQUIRED")) return "PAYMENT_CONSENT";
  if (blockers.size > 0) return "EXTERNAL";
  return input.published ? "LIVE" : "PUBLISH";
}

export function publicationCanPublish(input: {
  readonly dirty: boolean;
  readonly blockers: readonly string[];
  readonly suspended: boolean;
}): boolean {
  return !input.dirty && !input.suspended && input.blockers.length === 0;
}
