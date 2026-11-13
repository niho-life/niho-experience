/*
 * 団体・個別の相談 (#532, v0) — the form's fields and their rules, with no database and no server code, so the
 * browser's form, the public route and the store all read one list (a subpath export, like host-bio-rules).
 *
 * Only three things are required: a name, an email address and what the person wants to ask. Every other answer is
 * optional and may stay undecided; which ones are offered depends on the kind. Nothing here is a price, a stock or a
 * booking: an inquiry is not one (docs/group-inquiry.md).
 */

export const GROUP_INQUIRY_KINDS = ["PERSONAL", "CORPORATE", "SCHOOL", "LISTING"] as const;
export type GroupInquiryKind = (typeof GROUP_INQUIRY_KINDS)[number];

export const GROUP_INQUIRY_ENTRIES = ["DIRECT", "EXPERIENCE", "PROVIDER", "SCHOOL", "CORPORATE", "LISTING"] as const;
export type GroupInquiryEntry = (typeof GROUP_INQUIRY_ENTRIES)[number];

export const GROUP_INQUIRY_LOCALES = ["ja", "en"] as const;
export type GroupInquiryLocale = (typeof GROUP_INQUIRY_LOCALES)[number];

export const GROUP_INQUIRY_STATUSES = ["NEW", "IN_PROGRESS", "DONE"] as const;
export type GroupInquiryStatus = (typeof GROUP_INQUIRY_STATUSES)[number];

/** The limits migration 0074 keeps; the form's counters and the route use the same numbers. */
export const GROUP_INQUIRY_LIMITS = {
  nameMaxLength: 100,
  emailMaxLength: 254,
  messageMaxLength: 4000,
  experienceSlugMaxLength: 160,
  experienceTitleMaxLength: 200,
  hostNameMaxLength: 100,
  utmMaxLength: 64,
  assigneeMaxLength: 100,
  staffNoteMaxLength: 4000,
  /** New inquiries from one address / from everyone in the last hour. */
  perEmailPerHour: 3,
  perHour: 60,
} as const;

/**
 * The reply the sender is told to expect, and the office's own first due date. Chosen so the office can keep it
 * (owner: 2026-11-13, "返信期限は運営が守れる値を設定する"): provisional, two business days.
 */
export const GROUP_INQUIRY_REPLY_BUSINESS_DAYS = 2;

export type GroupInquiryFieldType = "text" | "longText" | "choice";
export type GroupInquiryField = {
  readonly key: string;
  readonly type: GroupInquiryFieldType;
  readonly maxLength: number;
  /** Allowed values of a `choice` (the empty choice is "not decided": the key is left out). */
  readonly choices?: readonly string[];
};

const text = (key: string, maxLength = 200): GroupInquiryField => ({ key, type: "text", maxLength });
const longText = (key: string, maxLength = 1000): GroupInquiryField => ({ key, type: "longText", maxLength });
const choice = (key: string, choices: readonly string[]): GroupInquiryField => ({ key, type: "choice", maxLength: 32, choices });

/** Whether a budget figure is per person or the whole group: asked next to the amount, optional like it. */
export const BUDGET_UNITS = ["PER_PERSON", "TOTAL"] as const;
export const VENUE_CHOICES = ["HAVE", "NEED", "UNDECIDED"] as const;
export const PAYER_CHOICES = ["SCHOOL", "TRAVEL_AGENCY", "UNDECIDED"] as const;

const BUDGET: readonly GroupInquiryField[] = [text("budget", 120), choice("budgetUnit", BUDGET_UNITS)];

/** The optional questions each kind adds. A key not listed for the kind is dropped, never stored. */
export const GROUP_INQUIRY_FIELDS: Readonly<Record<GroupInquiryKind, readonly GroupInquiryField[]>> = {
  PERSONAL: [text("people", 60), text("timing", 120), ...BUDGET],
  CORPORATE: [text("organization"), longText("purpose"), text("people", 60), text("timing", 200), choice("venue", VENUE_CHOICES), ...BUDGET],
  SCHOOL: [text("organization"), text("grade", 60), text("people", 60), text("timing", 200), text("availableTime", 120), longText("theme"), choice("payer", PAYER_CHOICES), ...BUDGET],
  LISTING: [longText("contentIdea"), text("area", 200), text("links", 400)],
};

export type GroupInquiryDetails = Readonly<Record<string, string>>;

/** A field the sender (or the browser) must fix: one of the three required ones, the kind, or a detail's key. */
export type GroupInquiryProblem = "kind" | "name" | "email" | "message" | `details.${string}` | "experience" | "entry" | "locale";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// eslint-disable-next-line no-control-regex -- the point is to refuse control characters
const CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F\u2028\u2029]/;
const ONE_LINE_CONTROL = /[\u0000-\u001F\u007F\u2028\u2029]/;

export type GroupInquiryInput = {
  readonly kind: GroupInquiryKind;
  readonly locale: GroupInquiryLocale;
  readonly name: string;
  readonly email: string;
  readonly message: string;
  readonly details: GroupInquiryDetails;
  readonly entry: GroupInquiryEntry;
  readonly experienceSlug: string | null;
  readonly experienceTitle: string | null;
  readonly hostName: string | null;
  readonly utmSource: string | null;
  readonly utmMedium: string | null;
  readonly utmCampaign: string | null;
};

export type GroupInquiryDraft = {
  readonly kind?: unknown;
  readonly locale?: unknown;
  readonly name?: unknown;
  readonly email?: unknown;
  readonly message?: unknown;
  readonly details?: unknown;
  readonly entry?: unknown;
  readonly experienceSlug?: unknown;
  readonly experienceTitle?: unknown;
  readonly hostName?: unknown;
  readonly utmSource?: unknown;
  readonly utmMedium?: unknown;
  readonly utmCampaign?: unknown;
};

export type GroupInquiryCheck = { readonly ok: true; readonly value: GroupInquiryInput } | { readonly ok: false; readonly problem: GroupInquiryProblem };

const SAFE_UTM = /^[a-z0-9_-]{1,64}$/;
const SAFE_SLUG = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,159}$/;

function optionalLine(value: unknown, max: number): string | null | "invalid" {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return "invalid";
  const trimmed = value.replace(/\s+/g, " ").trim();
  if (trimmed === "") return null;
  if (ONE_LINE_CONTROL.test(trimmed) || trimmed.length > max) return "invalid";
  return trimmed;
}

/**
 * The browser's draft, checked the way the store keeps it: trimmed, the kind's own optional answers kept (a value
 * longer than its limit, or a choice outside its list, is a problem the form points to), the rest dropped. Required:
 * a name, an email address, the message. Returns the first problem found; the form shows it next to its field.
 */
export function checkGroupInquiry(draft: GroupInquiryDraft): GroupInquiryCheck {
  if (typeof draft.kind !== "string" || !(GROUP_INQUIRY_KINDS as readonly string[]).includes(draft.kind)) return { ok: false, problem: "kind" };
  const kind = draft.kind as GroupInquiryKind;
  const locale = draft.locale ?? "ja";
  if (typeof locale !== "string" || !(GROUP_INQUIRY_LOCALES as readonly string[]).includes(locale)) return { ok: false, problem: "locale" };
  const entry = draft.entry ?? "DIRECT";
  if (typeof entry !== "string" || !(GROUP_INQUIRY_ENTRIES as readonly string[]).includes(entry)) return { ok: false, problem: "entry" };

  if (typeof draft.name !== "string") return { ok: false, problem: "name" };
  const name = draft.name.replace(/\s+/g, " ").trim();
  if (name.length < 1 || name.length > GROUP_INQUIRY_LIMITS.nameMaxLength || ONE_LINE_CONTROL.test(name)) return { ok: false, problem: "name" };
  if (typeof draft.email !== "string") return { ok: false, problem: "email" };
  const email = draft.email.trim();
  if (!EMAIL_PATTERN.test(email) || email.length > GROUP_INQUIRY_LIMITS.emailMaxLength || ONE_LINE_CONTROL.test(email)) return { ok: false, problem: "email" };
  if (typeof draft.message !== "string") return { ok: false, problem: "message" };
  const message = draft.message.replace(/\r\n?/g, "\n").trim();
  if (message.length < 1 || message.length > GROUP_INQUIRY_LIMITS.messageMaxLength || CONTROL.test(message)) return { ok: false, problem: "message" };

  const details: Record<string, string> = {};
  const given = draft.details;
  // Anything that is not an object of answers is no answers at all.
  if (given !== undefined && given !== null && typeof given === "object" && !Array.isArray(given)) {
    for (const field of GROUP_INQUIRY_FIELDS[kind]) {
      const raw = (given as Record<string, unknown>)[field.key];
      if (raw === undefined || raw === null) continue;
      if (typeof raw !== "string") return { ok: false, problem: `details.${field.key}` };
      const value = field.type === "longText" ? raw.replace(/\r\n?/g, "\n").trim() : raw.replace(/\s+/g, " ").trim();
      if (value === "") continue;
      if (value.length > field.maxLength || (field.type === "longText" ? CONTROL : ONE_LINE_CONTROL).test(value)) return { ok: false, problem: `details.${field.key}` };
      if (field.type === "choice" && !field.choices!.includes(value)) return { ok: false, problem: `details.${field.key}` };
      details[field.key] = value;
    }
  }

  const experienceSlug = optionalLine(draft.experienceSlug, GROUP_INQUIRY_LIMITS.experienceSlugMaxLength);
  if (experienceSlug === "invalid" || (experienceSlug !== null && !SAFE_SLUG.test(experienceSlug))) return { ok: false, problem: "experience" };
  const experienceTitle = optionalLine(draft.experienceTitle, GROUP_INQUIRY_LIMITS.experienceTitleMaxLength);
  const hostName = optionalLine(draft.hostName, GROUP_INQUIRY_LIMITS.hostNameMaxLength);
  if (experienceTitle === "invalid" || hostName === "invalid") return { ok: false, problem: "experience" };
  const utm = (value: unknown): string | null | "invalid" => {
    if (value === undefined || value === null || value === "") return null;
    return typeof value === "string" && SAFE_UTM.test(value) ? value : "invalid";
  };
  const utmSource = utm(draft.utmSource);
  const utmMedium = utm(draft.utmMedium);
  const utmCampaign = utm(draft.utmCampaign);
  // A tracking value that is not clean is dropped, not a reason to refuse the inquiry.
  return {
    ok: true,
    value: {
      kind,
      locale: locale as GroupInquiryLocale,
      name,
      email,
      message,
      details,
      entry: entry as GroupInquiryEntry,
      experienceSlug,
      experienceTitle,
      hostName,
      utmSource: utmSource === "invalid" ? null : utmSource,
      utmMedium: utmMedium === "invalid" ? null : utmMedium,
      utmCampaign: utmCampaign === "invalid" ? null : utmCampaign,
    },
  };
}

/** `YYYY-MM-DD` plus `days` weekdays (Saturday and Sunday skipped; national holidays are not). */
export function addBusinessDays(date: string, days: number): string {
  const day = new Date(`${date}T00:00:00.000Z`);
  let left = days;
  while (left > 0) {
    day.setUTCDate(day.getUTCDate() + 1);
    const weekday = day.getUTCDay();
    if (weekday !== 0 && weekday !== 6) left -= 1;
  }
  return day.toISOString().slice(0, 10);
}
