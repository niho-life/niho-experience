import { GROUP_INQUIRY_LIMITS, type GroupInquiryEntry, type GroupInquiryKind, type GroupInquiryLocale } from "@niho-experience/experience-store/group-inquiry-fields";

/*
 * Which page an inquiry started from, carried to the form in the URL (#532, docs/group-inquiry.md). Only public things
 * travel there: the kind, the entry, an experience's slug and title, a host's display name. A person's name, address or
 * words never do. The form keeps the context on screen until the inquiry is accepted.
 */

type SearchParams = Record<string, string | string[] | undefined>;

const TYPE: Record<string, GroupInquiryKind> = { personal: "PERSONAL", corporate: "CORPORATE", school: "SCHOOL", listing: "LISTING" };
const FROM: Record<string, GroupInquiryEntry> = { experience: "EXPERIENCE", provider: "PROVIDER", school: "SCHOOL", corporate: "CORPORATE", listing: "LISTING" };
const SLUG = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,159}$/;
const CONTROL = /[\u0000-\u001F\u007F\u2028\u2029]/;

const first = (value: string | string[] | undefined): string | null => (Array.isArray(value) ? value[0] : value) ?? null;

function shortText(value: string | null, max: number): string | null {
  if (value === null) return null;
  const text = value.replace(/\s+/g, " ").trim();
  return text !== "" && text.length <= max && !CONTROL.test(text) ? text : null;
}

export type InquiryEntryContext = {
  readonly kind: GroupInquiryKind;
  readonly entry: GroupInquiryEntry;
  readonly experienceSlug: string | null;
  readonly experienceTitle: string | null;
  readonly hostName: string | null;
};

/**
 * The form's first state from the page's query: `type` picks the kind, `from` names the kind of page, `experience`
 * (a slug) and `title` attach an experience, `host` a person. A value that does not fit is ignored: the form still
 * opens, with no context. Coming from an experience or a host with no `type` starts as an individual/group inquiry.
 * On the Japanese site (#589) a person is written to directly from their page, not through this form: an old link with
 * `from=provider` or `host=` and no experience opens with no context, so it still works and says nothing about a person.
 */
export function inquiryContextFromSearch(search: SearchParams, locale: GroupInquiryLocale = "en"): InquiryEntryContext {
  const experienceSlug = (() => {
    const slug = first(search.experience);
    return slug !== null && SLUG.test(slug) ? slug : null;
  })();
  const experienceTitle = experienceSlug ? shortText(first(search.title), GROUP_INQUIRY_LIMITS.experienceTitleMaxLength) : null;
  const hostName = locale === "ja" && experienceSlug === null ? null : shortText(first(search.host), GROUP_INQUIRY_LIMITS.hostNameMaxLength);
  const fromParam = first(search.from);
  const named = fromParam ? FROM[fromParam] : undefined;
  const requested = locale === "ja" && named === "PROVIDER" ? undefined : named;
  const entry: GroupInquiryEntry = experienceSlug && (requested === undefined || requested === "PROVIDER") ? (requested ?? "EXPERIENCE") : requested ?? (experienceSlug ? "EXPERIENCE" : hostName ? "PROVIDER" : "DIRECT");
  const typeParam = first(search.type);
  const kind = (typeParam ? TYPE[typeParam] : undefined) ?? (entry === "SCHOOL" ? "SCHOOL" : entry === "CORPORATE" ? "CORPORATE" : entry === "LISTING" ? "LISTING" : "PERSONAL");
  return { kind, entry, experienceSlug, experienceTitle, hostName };
}

/** The link to the form that carries a page's context (for the experience page, a host's page, the schools page...). */
export function inquiryHref(locale: GroupInquiryLocale, context: { readonly type?: GroupInquiryKind; readonly from?: GroupInquiryEntry; readonly experienceSlug?: string | null; readonly experienceTitle?: string | null; readonly hostName?: string | null } = {}): string {
  const params = new URLSearchParams();
  const type = context.type ? Object.entries(TYPE).find(([, kind]) => kind === context.type)?.[0] : undefined;
  if (type) params.set("type", type);
  // The Japanese site has no such entry any more (#589): a person is written to from their own page.
  const from = context.from && !(locale === "ja" && context.from === "PROVIDER") ? Object.entries(FROM).find(([, entry]) => entry === context.from)?.[0] : undefined;
  if (from) params.set("from", from);
  if (context.experienceSlug) {
    params.set("experience", context.experienceSlug);
    if (context.experienceTitle) params.set("title", context.experienceTitle.slice(0, GROUP_INQUIRY_LIMITS.experienceTitleMaxLength));
  }
  if (context.hostName && !(locale === "ja" && !context.experienceSlug)) params.set("host", context.hostName.slice(0, GROUP_INQUIRY_LIMITS.hostNameMaxLength));
  const query = params.toString();
  return `${locale === "ja" ? "/ja" : ""}/inquiry${query ? `?${query}` : ""}`;
}
