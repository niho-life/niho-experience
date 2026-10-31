import { EN_STATIC_COPY_V1, type DetailViewModelV1, type StaticCopyAccessorV1 } from "@niho/experience-presentation/v1";
import type { ExperienceProviderPagePreviewOfferSummary, ExperienceProviderPagePreviewOccurrence, ExperienceProviderPagePreviewResponse } from "@niho-experience/api-client/host";
import { groupSizeLabel, initialOf } from "@/lib/card-model";
import { formatDay, formatDuration, formatTimeRange, formatYen, jstDateKey } from "@/lib/format";
import { addMinutesToClock, formatClock, joinAnd, scheduleLine, scheduleSummary } from "@/lib/schedule";
import { iconForText } from "@/lib/themes";

/*
 * 体験ページのプレビュー (#89): NIHO's public assembly of the saved page (`GET …/pages/{pageId}/preview`) as the
 * model of this site's experience detail (`DetailViewV1`, the same view the traveler sees). Pure and English, like
 * the traveler's page: a Japanese page shows its English translation where there is one and says so.
 * Nothing here is booked, linked or counted: `meetingPoint` is always null in the preview (the meeting point is
 * saved apart and reaches the traveler only after a confirmed booking), and the dates carry no seat counts.
 */

const NEXT_DATE_COUNT = 3;

export type PreviewDateRow = { key: string; day: string; time: string };
/** What the booking card shows, without its controls: the price, when it runs and the next bookable dates. */
export type PreviewBookingCard = { price: string; priceIsFrom: boolean; childNote: string | null; schedule: string | null; canBook: boolean; dates: PreviewDateRow[]; assurances: { icon: "check" | "people" | "mail" | "card"; text: string }[] };
export type PreviewView = {
  model: Omit<DetailViewModelV1, "booking">;
  booking: PreviewBookingCard;
  /** The page is Japanese: the experience site lists English pages only. */
  japanese: boolean;
  /** Every item of the English page has English text (always true for an English page). */
  fullyTranslated: boolean;
};

type PreviewOffer = ExperienceProviderPagePreviewResponse["offers"][number];
const present = (value: string | null | undefined): value is string => typeof value === "string" && value.trim() !== "";

/** "English, with an English-speaking guide" → "English" / "with an English-speaking guide"; otherwise the note and "language" (as the traveler's page does). */
function languageFact(note: string): { main: string; sub: string } {
  const split = /^(.+?),\s+(with .+)$/i.exec(note.trim());
  return split ? { main: split[1]!, sub: split[2]! } : { main: note, sub: "language" };
}

function durationFact(offers: readonly PreviewOffer[], copy: StaticCopyAccessorV1): { main: string; sub: string | null } {
  const durations = [...new Set(offers.map((offer) => offer.durationMinutes))].sort((a, b) => a - b);
  const main = durations.length ? (durations.length === 1 ? formatDuration(durations[0]!) : `${formatDuration(durations[0]!)}–${formatDuration(durations.at(-1)!)}`) : copy.text("detail.notListed");
  const first = offers[0];
  const same = first && offers.every((offer) => offer.startTime === first.startTime && offer.durationMinutes === first.durationMinutes);
  const sub = first && same ? `${formatClock(first.startTime)} – ${formatClock(addMinutesToClock(first.startTime, first.durationMinutes))} JST` : first ? copy.text("detail.chooseDate") : null;
  return { main, sub };
}

/** The weekdays an offer runs on, read from its dated occurrences (the preview's offers carry no weekday list). */
const weekdaysOf = (occurrences: readonly ExperienceProviderPagePreviewOccurrence[]): number[] => [...new Set(occurrences.map((item) => new Date(`${jstDateKey(item.startAt)}T12:00:00Z`).getUTCDay()))];

function childLine(offers: readonly ExperienceProviderPagePreviewOfferSummary[]): { fact: string | null; price: string | null } {
  const children = offers.flatMap((offer) => offer.childPriceYen !== null && offer.childMinAge !== null && offer.childMaxAge !== null ? [{ price: offer.childPriceYen, min: offer.childMinAge, max: offer.childMaxAge, adult: offer.adultRequiredForChild }] : []);
  const first = children[0];
  if (!first) return { fact: null, price: null };
  if (children.length !== offers.length || children.some((child) => child.min !== first.min || child.max !== first.max || child.adult !== first.adult)) return { fact: "Children: see options", price: "Children's terms vary by option" };
  const ages = first.min === first.max ? `age ${first.min}` : `ages ${first.min}–${first.max}`;
  const prices = [...new Set(children.map((child) => child.price))];
  return { fact: `${ages}${first.adult ? " with an adult" : ""}`, price: `Children ${first.min === first.max ? first.min : `${first.min}–${first.max}`} ${prices.length > 1 ? "from " : ""}${formatYen(Math.min(...prices))}` };
}

/** The next bookable dates: the first bookable occurrence of each of the next days. */
export function previewNextDates(occurrences: readonly ExperienceProviderPagePreviewOccurrence[], count = NEXT_DATE_COUNT): PreviewDateRow[] {
  const rows: PreviewDateRow[] = []; const seen = new Set<string>();
  for (const item of [...occurrences].sort((a, b) => a.startAt.localeCompare(b.startAt))) {
    if (!item.bookable || seen.has(item.date)) continue;
    seen.add(item.date); rows.push({ key: item.startAt, day: formatDay(item.startAt), time: formatTimeRange(item.startAt, item.endAt) });
    if (rows.length === count) break;
  }
  return rows;
}

export function buildPreviewView(preview: ExperienceProviderPagePreviewResponse, copy: StaticCopyAccessorV1 = EN_STATIC_COPY_V1): PreviewView {
  const { page, spot, offers } = preview;
  const japanese = page.language !== "EN";
  let translated = true;
  /** The English text where the page is Japanese and has it; otherwise what the page says. */
  const text = (own: string, en: string | null | undefined) => { if (!japanese) return own; if (present(en)) return en; if (present(own)) translated = false; return own; };
  const list = (own: readonly string[], en: readonly (string | null)[]) => own.map((item, at) => text(item, en[at]));

  const title = text(page.title, page.titleEn);
  const content = page.content;
  const photos = [page.coverUrl, ...page.photos.map((photo) => photo.url)].filter((url, at, all): url is string => Boolean(url) && all.indexOf(url) === at);
  const toImage = (url: string | null | undefined, alt: string) => url ? { src: url, alt } : null;
  // NIHO's avatar paths are not on this site: only an https URL is shown, otherwise the initial.
  const hosts = preview.hosts.length
    ? preview.hosts.map((host) => ({ name: host.displayName, initial: initialOf(host.displayName), image: toImage(host.avatarUrl?.startsWith("https://") ? host.avatarUrl : null, host.displayName) }))
    : [{ name: spot.name, initial: initialOf(spot.name), image: null }];
  const hostNames = preview.hosts.length ? joinAnd(preview.hosts.map((host) => host.displayName)) : spot.name;
  const paragraphs = text(content.description, content.descriptionEn).split(/\n\s*\n/).filter((paragraph) => paragraph.trim());

  const firstPolicy = offers[0]?.cancellationPolicy;
  const sharedPolicy = firstPolicy && offers.every((offer) => offer.cancellationPolicy === firstPolicy) ? firstPolicy : null;
  const policyTitle = sharedPolicy === "NONE" ? copy.text("detail.nonRefundable") : sharedPolicy ? `Free cancellation until ${sharedPolicy === "FREE_UNTIL_48H" ? 48 : 24} hours before the start` : null;
  const modes = new Set(offers.map((offer) => offer.acceptanceMode));
  const acceptanceNote = modes.size === 1 && modes.has("APPROVAL") ? copy.text("booking.approvalNote") : modes.size === 1 && modes.has("INSTANT") ? copy.text("booking.instantNote") : copy.text("detail.policyApplies");

  const scheduleOffers = offers.map((offer) => ({ weekdays: weekdaysOf(offer.occurrences), startTime: offer.startTime }));
  const schedule = scheduleOffers.some((offer) => offer.weekdays.length) ? scheduleLine(scheduleOffers.filter((offer) => offer.weekdays.length)) : null;
  const group = groupSizeLabel(offers);
  const children = childLine(offers);
  const duration = durationFact(offers, copy);
  const language = languageFact(text(content.facts.language, content.facts.languageEn));
  const adultPrices = offers.map((offer) => offer.priceYen);
  const dates = previewNextDates(offers.flatMap((offer) => offer.occurrences));
  const approval = offers.filter((offer) => offer.acceptanceMode === "APPROVAL").length;

  const model: PreviewView["model"] = {
    title,
    backHref: "#preview",
    gallery: { title, backHref: "#preview", photos: photos.map((url, index) => { const alt = index === 0 ? title : `${title}, photo ${index + 1} of ${photos.length}`; return { image: { src: url, alt }, alt }; }) },
    schedule: schedule ?? undefined,
    hosts,
    hostLine: copy.rich(preview.hosts.length ? "detail.hostedOfRich" : "detail.hostedByRich", { hosts: hostNames, provider: spot.name }),
    facts: [
      { icon: "clock", label: copy.text("detail.durationLabel"), main: duration.main, sub: duration.sub },
      { icon: "chat", label: copy.text("detail.languageLabel"), ...language },
      ...(group ? [{ icon: "people" as const, label: copy.text("detail.groupSize"), main: group, sub: children.fact ?? copy.text("detail.smallGroup") }] : []),
    ],
    lead: text(content.lead, content.leadEn),
    highlights: list(content.highlights, content.highlightsEn).map((item) => ({ text: item, icon: iconForText(item) })),
    paragraphs,
    timeline: content.timeline.map((step) => {
      const stepTitle = text(step.title, step.titleEn); const stepText = text(step.text, step.textEn);
      return { time: step.time ? formatClock(step.time) : undefined, title: stepTitle, text: stepText, icon: iconForText(`${stepTitle} ${stepText}`, "clock"), photo: step.photoIndex !== null && page.photos[step.photoIndex] ? toImage(page.photos[step.photoIndex]!.url, `${title}, ${stepTitle}`) : null };
    }),
    provider: { name: spot.name, tagline: (japanese ? spot.taglineEn : spot.tagline) ?? undefined, photo: toImage(photos[1] ?? photos[0], ""), hosts },
    included: list(content.included, content.includedEn),
    notIncluded: list(content.notIncluded, content.notIncludedEn),
    emptyListLabel: copy.text("detail.noneListed"),
    // `spot.meetingPoint` is always null here: what the traveler sees before booking (the line only) is not in the preview.
    meeting: { kind: "after-booking" },
    know: list(content.knowBeforeYouGo, content.knowBeforeYouGoEn),
    showAllKnowLabel: copy.text("detail.showAllCount", { count: content.knowBeforeYouGo.length }),
    notSuitable: list(content.notSuitableFor, content.notSuitableForEn),
    cancellation: { policy: policyTitle ? { title: policyTitle, acceptanceNote } : undefined, sellerName: spot.name },
  };

  const assurances: PreviewBookingCard["assurances"] = [];
  if (sharedPolicy) assurances.push({ icon: "check", text: policyTitle! });
  if (approval) assurances.push({ icon: "people", text: approval === offers.length ? "Your hosts confirm each request — you're only charged if they accept" : "Some options are confirmed by your hosts — you're only charged if they accept" });
  assurances.push({ icon: "mail", text: copy.text("detail.noAccount") }, { icon: "card", text: copy.text("detail.secureStripe") });

  return {
    model,
    booking: {
      price: adultPrices.length ? formatYen(Math.min(...adultPrices)) : "—",
      priceIsFrom: new Set(adultPrices).size > 1,
      childNote: children.price,
      schedule: offers.length ? scheduleSummary(scheduleOffers.filter((offer) => offer.weekdays.length)) : null,
      canBook: dates.length > 0,
      dates,
      assurances,
    },
    japanese,
    fullyTranslated: translated,
  };
}
