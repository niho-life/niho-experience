import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import postcss from "postcss";
import { describe, expect, it } from "vitest";
import { bookingCardModel } from "../../../apps/web/src/lib/presentation-booking-model";
import {
  BookingCheckoutViewV1, BookingPageViewV1, BookingPreviewV1, CatalogueViewV1, COPY_REGISTRY_V1, DetailViewV1, EN_COPY_V1, EN_STATIC_COPY_V1, ExperienceCardV1, HelpViewV1,
  HomeViewV1, HostViewV1, MobileGalleryViewV1, PRESENTATION_MANIFEST_V1, PresentationRootV1, SiteFooterV1, SiteHeaderV1, DetailBookingDatesV1,
  RichMessageV1, STATIC_COPY_REGISTRY_V1, assertAssetBindingsV1, assertPresentationIdentityV1, createCopyV1, createStaticCopyV1,
  defaultAssetBindingsV1, defaultStaticCopyValuesV1, type BookingPreviewModelV1, type DetailViewModelV1, type HomeViewModelV1,
} from "../src/v1/index";

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoDir = resolve(packageDir, "../..");
const sha256 = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
const image = { src: "/synthetic/image.svg", alt: "Synthetic scene" };
const video = { src: "/synthetic/video.mp4", poster: "/synthetic/poster.svg" };
const card = { slug: "synthetic-workshop", href: "/experiences/synthetic-workshop", cover: image, face: { name: "Sample Host", initial: "S", image: null }, groupLabel: "Up to 4 guests", withLabel: "with Sample Host", title: "A synthetic workshop", lead: "Invented preview data.", durationLabel: "2 hours", language: { short: "EN", full: "English" }, scheduleLabel: "Sat · 2:00 PM", priceLabel: "¥4,000", priceIsFrom: false, priceSuffix: " / adult" };

const home: HomeViewModelV1 = {
  hero: image, finder: <form><button>Find experiences</button></form>,
  themes: [{ key: "make", href: "/experiences/synthetic-workshop", icon: "mend", label: "Make" }], cardsEyebrow: "one to choose from", cards: [{ model: card, dates: <span>Sat 24</span> }],
  feature: { heading: "A synthetic feature", body: "Invented preview story.", cta: "See details", href: card.href, photos: [image, image, image, image, image] },
  strips: [{ key: "make", href: card.href, verb: "Make", name: "Synthetic workshop", video }], stripsEyebrow: "one small way into Kamakura", banner: video,
  hostFeature: { headingEyebrow: "Meet your neighbors", headingTitle: "The people are the point", moreHostsLabel: "More hosts", name: "Sample Host", role: "Maker", story: "An invented host for preview.", cta: "See the workshop", href: card.href, image, faces: [{ face: card.face, href: card.href, label: card.title, current: true }] },
  figures: [{ value: "2", unit: "hours", note: "Synthetic duration." }, { value: "4", unit: "guests", note: "Synthetic group." }],
  postcards: [{ id: "synthetic", image, place: "Sample place", rotate: 0 }], hostBand: video,
};
const bookingPreview: BookingPreviewModelV1 = {
  selection: {
    summary: { title: card.title, image, summary: "2 hours · 2:00 PM JST" },
    offers: [{ id: "synthetic-standard", name: "Synthetic standard option", adultPrice: "¥4,000", selected: true }, { id: "synthetic-private", name: "Synthetic private option", adultPrice: "¥12,000", selected: false }],
    dates: { state: "ready", provisional: true, options: [{ id: "synthetic-date", weekday: "Sat", day: "24 Oct", time: "2:00 PM – 4:00 PM", bookable: true, selected: true }, { id: "synthetic-full", weekday: "Sun", day: "25 Oct", time: "10:00 AM – 12:00 PM", availability: "Full", bookable: false, selected: false }], moreCount: 2 },
    counters: [{ id: "adult-preview", label: "Adults", note: "¥4,000 each", value: 2, maximum: 4, full: false }, { id: "child-preview", label: "Children", note: "Ages 8–15 · ¥2,000 each, with an adult", value: 0, maximum: 4, full: false }],
    guestRange: { minimum: 1, maximum: 4, childrenPrice: "¥2,000" }, total: "¥8,000", totalIsAmount: true, line: "Sat 24 Oct · 2:00 PM", canContinue: false,
  },
  checkout: {
    summary: { title: card.title, image, summary: "2 hours · 2:00 PM JST" }, availability: "ready", refreshing: false, refreshDisabled: true,
    guestName: "Synthetic Guest", invalidGuestName: false, guestEmail: "guest@example.invalid", invalidGuestEmail: false, note: "Invented preview note.", invalidNote: false,
    questions: [
      { id: "short", prompt: "What name should the host use?", required: true, type: "SHORT_TEXT", value: "Sample", options: [] },
      { id: "long", prompt: "What would you like to explore?", required: false, type: "LONG_TEXT", value: "Synthetic answer.", options: [] },
      { id: "single", prompt: "Choose a synthetic material", required: true, type: "SINGLE_SELECT", value: ["paper"], options: [{ id: "paper", label: "Paper" }, { id: "cloth", label: "Cloth" }] },
      { id: "multi", prompt: "Select accessibility preferences", required: false, type: "MULTI_SELECT", value: ["seated"], options: [{ id: "seated", label: "Seated activity" }, { id: "quiet", label: "Quiet space" }] },
    ],
    approval: false, review: [{ label: "Date", value: "Sat 24 Oct · 2:00 PM JST" }, { label: "Guests", value: "2 adults" }], total: "¥8,000", policyTitle: "Free until 48 hours before", sellerName: "Synthetic Studio", sellerLegalUrl: "https://example.invalid/seller",
    legalDocuments: [{ kind: "COMMERCIAL_TRANSACTIONS", url: "https://example.invalid/seller" }, { kind: "PRIVACY", url: "https://example.invalid/privacy" }, { kind: "TERMS", url: "https://example.invalid/terms" }],
    consentVersion: "synthetic-v1", agreed: true, invalidConsent: false, preview: true, submitting: false, retryWaiting: false, actionDisabled: true, when: "Sat 24 Oct · 2:00 PM",
  },
};

const detailModel: DetailViewModelV1 = { title: card.title, backHref: "/experiences", gallery: { title: card.title, backHref: "/experiences", photos: [{ image, alt: "Synthetic gallery image" }, { image: { ...image, src: "/synthetic/image-2.svg" }, alt: "Second synthetic gallery image" }] }, hosts: [card.face], hostLine: EN_STATIC_COPY_V1.rich("detail.hostedByRich", { hosts: "Sample Host" }), facts: [{ icon: "clock", label: "Duration", main: "2 hours" }], lead: card.lead, highlights: [{ text: "Synthetic highlight", icon: "check" }], paragraphs: ["First paragraph.", "Second paragraph."], timeline: [{ title: "Make", text: "Synthetic step.", icon: "mend" }], provider: { name: "Synthetic Studio", hosts: [card.face], photo: image }, included: ["Materials"], notIncluded: ["Transport"], emptyListLabel: "None listed.", meeting: { kind: "after-booking" }, know: ["Synthetic note"], showAllKnowLabel: "Show all 1", notSuitable: [], cancellation: { policy: { title: "Synthetic cancellation terms", acceptanceNote: "Applies to this option." }, sellerName: "Synthetic Studio" }, booking: { price: "¥4,000", priceIsFrom: false, canBook: true, bookingHref: "/experiences/synthetic-workshop/book", actionLabel: "Check dates and book", assurances: [{ icon: "check", text: "Synthetic assurance" }], dates: <span>Synthetic dates controller</span> } };

describe("v1 portable presentation", () => {
  it("keeps the header host link visible when a caller supplies an empty label", () => {
    const html = renderToStaticMarkup(<SiteHeaderV1 labels={{ host: "" }} />);
    expect(html).toContain("Host with NIHO");
  });

  it("renders keyboard and button controls for the mobile photo gallery", () => {
    const html = renderToStaticMarkup(<MobileGalleryViewV1 model={{ title: card.title, backHref: "/experiences", photos: [{ image, alt: "Synthetic gallery image" }, { image: { ...image, src: "/synthetic/image-2.svg" }, alt: "Second synthetic gallery image" }] }} />);
    expect(html).toContain('aria-roledescription="carousel"');
    expect(html).toContain('aria-describedby=');
    expect(html).toContain('aria-label="Previous photo"');
    expect(html).toContain('aria-label="Next photo"');
    expect(html).toContain('role="status"');
    expect(html).toContain("Use the left and right arrow keys to browse photos.");
  });

  it("exposes checkout error focus targets to the shared booking form", () => {
    const invalidCheckout = {
      ...bookingPreview.checkout,
      problem: "Please check your booking.",
      invalidGuestName: true,
      invalidGuestEmail: false,
      invalidNote: false,
      questions: bookingPreview.checkout.questions.map((question) => ({ ...question, invalid: question.id === "short" || question.id === "multi" })),
      invalidConsent: true,
    };
    const html = renderToStaticMarkup(<BookingCheckoutViewV1 model={invalidCheckout} />);
    expect(html).toContain('id="booking-guestName" aria-invalid="true" aria-describedby="booking-problem"');
    expect(html).toContain('id="question-short"');
    expect(html).toContain('id="question-multi" tabindex="-1"');
    expect(html).toMatch(/id="booking-consent"[^>]*aria-describedby="booking-problem"/);
  });

  it("必須の読み上げ文言を言語別の共通コピーから表示する", () => {
    const copy = createStaticCopyV1({ ...defaultStaticCopyValuesV1(), "booking.required": "必須" });
    const ja = renderToStaticMarkup(<BookingCheckoutViewV1 model={bookingPreview.checkout} copy={copy} />);
    expect(ja).toContain('<span class="sr-only"> (必須)</span>');
    expect(ja).not.toContain('<span class="sr-only"> (required)</span>');
    const en = renderToStaticMarkup(<BookingCheckoutViewV1 model={bookingPreview.checkout} />);
    expect(en).toContain('<span class="sr-only"> (required)</span>');
  });

  it("renders a public overview as text while keeping after-booking directions private", () => {
    const meeting = {
      kind: "after-booking" as const,
      overview: "Around Kamakura <studio>",
      name: "Private studio",
      address: "Private address",
      accessNote: "Private access",
      entranceNote: "Private entrance",
      mapUrl: "https://example.invalid/private-map",
      exterior: { src: "/synthetic/private-exterior.svg", alt: "Private exterior" },
    };
    const html = renderToStaticMarkup(<DetailViewV1 model={{ ...detailModel, meeting }} />);
    expect(html).toContain("Around Kamakura &lt;studio&gt;");
    expect(html).toContain(EN_STATIC_COPY_V1.text("detail.meetingAfterBooking"));
    for (const secret of ["Private studio", "Private address", "Private access", "Private entrance", "private-map", "private-exterior"]) expect(html).not.toContain(secret);
  });

  it("retains published meeting directions and the overview for a public location", () => {
    const html = renderToStaticMarkup(<DetailViewV1 model={{ ...detailModel, meeting: {
      kind: "location", overview: "Near Kamakura station", name: "Public studio", address: "Public address", mapUrl: "https://example.invalid/public-map",
    } }} />);
    expect(html).toContain("Near Kamakura station");
    expect(html).toContain("Public address");
    expect(html).toContain('href="https://example.invalid/public-map"');
    expect(html).not.toContain(EN_STATIC_COPY_V1.text("detail.meetingAfterBooking"));
  });

  it("shows structured conditions and the ask slot inside Good to know, and nothing extra without them", () => {
    const plain = renderToStaticMarkup(<DetailViewV1 model={detailModel} />);
    expect(plain).toContain("Synthetic note");
    expect(plain).not.toContain("Ask slot");
    const withConditions = renderToStaticMarkup(<DetailViewV1 model={{ ...detailModel, know: [], conditions: [{ icon: "people", headline: "Ages 10 and up", detail: "Children must join with an adult" }, { icon: "umbrella", headline: "Rain or shine" }], askHost: <button>Ask slot</button> }} />);
    expect(withConditions).toContain(EN_STATIC_COPY_V1.text("detail.goodToKnow"));
    expect(withConditions).toContain("Ages 10 and up");
    expect(withConditions).toContain("Children must join with an adult");
    expect(withConditions.indexOf("Ages 10 and up")).toBeLessThan(withConditions.indexOf("Rain or shine"));
    expect(withConditions.indexOf("Rain or shine")).toBeLessThan(withConditions.indexOf("Ask slot"));
    expect(withConditions).not.toContain("Synthetic note");
    // Host-written notes stay under the structured rows when both exist.
    const both = renderToStaticMarkup(<DetailViewV1 model={{ ...detailModel, conditions: [{ icon: "people", headline: "Ages 10 and up" }] }} />);
    expect(both.indexOf("Ages 10 and up")).toBeLessThan(both.indexOf("Synthetic note"));
  });

  it("keeps the ask slot when an experience has no Good to know content", () => {
    const html = renderToStaticMarkup(<DetailViewV1 model={{ ...detailModel, know: [], notSuitable: [], askHost: <button>Ask slot</button> }} />);
    expect(html).not.toContain(EN_STATIC_COPY_V1.text("detail.goodToKnow"));
    expect(html).toContain("Ask slot");
    expect(renderToStaticMarkup(<DetailViewV1 model={{ ...detailModel, know: [], notSuitable: [] }} />)).not.toContain("Ask slot");
  });

  it("shows the review line under the title (a link, a plain count, or the New badge) and the reviews section before the cancellation terms", () => {
    const plain = renderToStaticMarkup(<DetailViewV1 model={detailModel} />);
    expect(plain).not.toContain('id="reviews"');
    const linked = renderToStaticMarkup(<DetailViewV1 model={{ ...detailModel, reviewHeadline: { label: "★ 4.9 · 12 reviews", accessibleLabel: "Rated 4.9 out of 5 from 12 reviews. Go to the reviews", href: "#reviews" }, reviews: { title: "Reviews", content: <p>Reviews content</p> } }} />);
    expect(linked).toContain('<a href="#reviews" aria-label="Rated 4.9 out of 5 from 12 reviews. Go to the reviews"');
    expect(linked).toContain("★ 4.9 · 12 reviews");
    expect(linked).toMatch(/<section id="reviews" class="scroll-mt-24 pt-12"><h2[^>]*>Reviews<\/h2><p>Reviews content<\/p>/);
    // The line sits right under the title, before the host row; the section sits before the cancellation terms.
    expect(linked.indexOf("★ 4.9")).toBeGreaterThan(linked.indexOf("</h1>"));
    expect(linked.indexOf("★ 4.9")).toBeLessThan(linked.indexOf("Hosted by"));
    expect(linked.indexOf('id="reviews"')).toBeLessThan(linked.indexOf(EN_STATIC_COPY_V1.text("detail.cancellation")));
    const count = renderToStaticMarkup(<DetailViewV1 model={{ ...detailModel, reviewHeadline: { label: "2 reviews", href: "#reviews" } }} />);
    expect(count).toContain(">2 reviews</a>");
    const fresh = renderToStaticMarkup(<DetailViewV1 model={{ ...detailModel, reviewHeadline: { label: "New", isNew: true } }} />);
    expect(fresh).toContain(">New</span>");
    expect(fresh).not.toContain('href="#reviews"');
  });

  it("adds host introductions, an upcoming-dates slot and the FAQ only when the consumer supplies them", () => {
    const plain = renderToStaticMarkup(<DetailViewV1 model={detailModel} />);
    expect(plain).not.toContain('id="faq"');
    expect(plain).not.toContain("Upcoming slot");
    const one = renderToStaticMarkup(<DetailViewV1 model={{ ...detailModel, provider: { ...detailModel.provider, bios: [{ name: "Sample Host", text: "An invented host.\nSecond line." }] }, upcoming: <p>Upcoming slot</p>, faq: { title: "Frequently asked questions", items: [{ question: "What should I wear?", answer: "Comfortable clothes." }, { question: "Is it <b>safe</b>?", answer: "Yes." }] } }} />);
    // A single host's introduction carries no name prefix; plain text is escaped, never parsed as markup.
    expect(one).toContain(">An invented host.\nSecond line.</p>");
    expect(one).not.toContain("Sample Host</b> · ");
    // Right under the title (and its review line), before the host row: high enough to be seen on a phone without scrolling.
    expect(one.indexOf("Upcoming slot")).toBeGreaterThan(one.indexOf("</h1>"));
    expect(one.indexOf("Upcoming slot")).toBeLessThan(one.indexOf("Hosted by"));
    expect(one).toMatch(/<section id="faq" class="scroll-mt-24 pt-12"><h2[^>]*>Frequently asked questions<\/h2>/);
    expect(one).toMatch(/<h3[^>]*>What should I wear\?<\/h3><p[^>]*>Comfortable clothes\.<\/p>/);
    expect(one).toContain("Is it &lt;b&gt;safe&lt;/b&gt;?");
    expect(one.indexOf('id="faq"')).toBeLessThan(one.indexOf(EN_STATIC_COPY_V1.text("detail.cancellation")));
    const two = renderToStaticMarkup(<DetailViewV1 model={{ ...detailModel, provider: { ...detailModel.provider, bios: [{ name: "Host A", text: "First." }, { name: "Host B", text: "Second." }] }, faq: { title: "FAQ", items: [] } }} />);
    expect(two).toContain("Host A</b> · First.");
    expect(two).toContain("Host B</b> · Second.");
    expect(two).not.toContain('id="faq"');
  });

  it("adds footer links after the fixed ones only when given", () => {
    expect(renderToStaticMarkup(<SiteFooterV1 />)).not.toContain('href="/guides"');
    const html = renderToStaticMarkup(<SiteFooterV1 links={[{ href: "/guides", label: "Guides" }]} />);
    expect(html).toContain('<a href="/guides" class="hover:underline">Guides</a>');
    expect(html.indexOf('href="/help"')).toBeLessThan(html.indexOf('href="/guides"'));
  });

  it("adds a review line to a card only when the consumer supplies one", () => {
    const model = { ...card, href: card.href };
    expect(renderToStaticMarkup(<ExperienceCardV1 card={model} />)).not.toContain("★");
    const rated = renderToStaticMarkup(<ExperienceCardV1 card={{ ...model, reviewLine: { text: "★ 4.9 · 12", label: "Rated 4.9 out of 5 from 12 reviews" } }} />);
    expect(rated).toContain('<span aria-hidden="true">★ 4.9 · 12</span><span class="sr-only">Rated 4.9 out of 5 from 12 reviews</span>');
  });

  it("adds Before you book, the mobile number and a host heading to checkout without changing the default screen", () => {
    const base = renderToStaticMarkup(<BookingCheckoutViewV1 model={bookingPreview.checkout} />);
    expect(base).not.toContain('name="conditions"');
    expect(base).not.toContain('name="guestPhone"');
    expect(base).toContain(EN_STATIC_COPY_V1.text("booking.hostQuestions"));
    const stepOf = (html: string, id: string) => new RegExp(`id="${id}"[^>]*><span[^>]*>step (\\d)</span>`).exec(html)?.[1];
    const extended = renderToStaticMarkup(<BookingCheckoutViewV1 model={{
      ...bookingPreview.checkout,
      hostQuestionsHeading: "Questions from Sample Host",
      guestPhone: { label: "Mobile number", hint: "(optional, for the day)", value: "+44 7700 900123", invalid: false },
      conditions: { heading: "Before you book", agreeIntro: "Everyone in my group is OK with:", items: ["Ages 10 and up", "Steps up to the studio"], agreed: false, invalid: false },
    }} />);
    expect(extended).toContain('id="booking-conditions"');
    expect(extended).toContain("Before you book");
    expect(extended).toContain("Ages 10 and up");
    expect(extended).toContain('type="tel"');
    expect(extended).toContain("Mobile number");
    expect(extended).toContain("Questions from Sample Host");
    expect(extended).not.toContain(EN_STATIC_COPY_V1.text("booking.hostQuestions"));
    // The conditions come first; details and the final check shift down by one step.
    expect(extended.indexOf('id="conditions-heading-v1"')).toBeLessThan(extended.indexOf('id="details-heading-v1"'));
    expect(extended.indexOf('id="details-heading-v1"')).toBeLessThan(extended.indexOf('id="check-heading-v1"'));
    expect([stepOf(extended, "conditions-heading-v1"), stepOf(extended, "details-heading-v1"), stepOf(extended, "check-heading-v1")]).toEqual(["3", "4", "5"]);
    expect([stepOf(base, "details-heading-v1"), stepOf(base, "check-heading-v1")]).toEqual(["3", "4"]);
    const invalid = renderToStaticMarkup(<BookingCheckoutViewV1 model={{ ...bookingPreview.checkout, conditions: { heading: "Before you book", agreeIntro: "OK?", items: ["A"], agreed: false, invalid: true }, guestPhone: { label: "Mobile number", value: "x", invalid: true } }} />);
    expect(invalid).toContain('aria-invalid="true"');
    expect(invalid).toContain("border-danger");
  });

  it("renders the complete route structures through React SSR", () => {
    const detail = <DetailViewV1 model={detailModel} />;
    const booking = <BookingPageViewV1 backHref={card.href} backLabel={card.title} panel={<BookingPreviewV1 model={bookingPreview} />} />;
    const routes = renderToStaticMarkup(<PresentationRootV1><SiteHeaderV1 /><HomeViewV1 model={home} /><CatalogueViewV1 content={<div>Catalogue controller</div>} />{detail}{booking}<HelpViewV1 model={{ primaryHref: "mailto:test@example.invalid", primaryLabelKey: "help.email", emailHref: "mailto:test@example.invalid", emailLabel: "test@example.invalid" }} /><HostViewV1 model={{ video, steps: [{ title: "Plan", body: "Synthetic step" }], you: ["Host"], niho: ["Help"], signup: <div>Signup controller</div>, signupOpen: false }} /><SiteFooterV1 /></PresentationRootV1>);
    for (const marker of ["Meet the people who make Kamakura", "Experiences hosted by", "Slow down", "Small on purpose", "Simple, in yen", "Kamakura is small", "Experiences in Kamakura", "What you&#x27;ll do", "Show all 2 photos", "data-booking-screen=\"selection\"", "data-booking-screen=\"checkout\"", "What name should the host use?", "Select accessibility preferences", "Booking terms:", "Synthetic dates controller", "Booking help", "Share what you love with travelers", "NIHO Experience"]) expect(routes).toContain(marker);
  });

  it("keeps every English code-owned route on v1", async () => {
    const consumers = {
      "apps/web/src/app/(site)/page.tsx": ["HomeViewV1"],
      "apps/web/src/app/(site)/experiences/(list)/page.tsx": ["CatalogueViewV1"],
      "apps/web/src/app/(site)/experiences/[slug]/page.tsx": ['ExperiencePageContent({ ...props, locale: "en" })'],
      "apps/web/src/components/pages/ExperiencePageContent.tsx": ["DetailViewV1"],
      "apps/web/src/app/(site)/experiences/[slug]/book/page.tsx": ['BookingPageContent({ ...props, locale: "en" })'],
      "apps/web/src/components/pages/BookingPageContent.tsx": ["BookingPageViewV1"],
      "apps/web/src/app/(site)/help/page.tsx": ["HelpViewV1"],
      "apps/web/src/app/(site)/host/page.tsx": ['HostPageContent({ ...props, locale: "en" })'],
      "apps/web/src/components/pages/HostPageContent.tsx": ["HostViewV1"],
      "apps/web/src/components/SiteChrome.tsx": ["PresentationRootV1", "SiteHeaderV1", "SiteFooterV1"],
      "apps/web/src/components/BookingParts.tsx": ["BookingSummaryV1", "BookingStepHeadingV1", "BookingBarV1"],
      "apps/web/src/components/SlotPicker.tsx": ["BookingSelectionViewV1", "BookingSelectionViewModelV1"],
      "apps/web/src/components/BookingForm.tsx": ["BookingCheckoutViewV1", "BookingCheckoutViewModelV1"],
      "apps/web/src/components/DetailGallery.tsx": ["MobileGalleryViewV1", "DesktopGalleryViewV1"],
      "apps/web/src/components/DetailBooking.tsx": ["DetailBookingCardV1", "DetailBookingDatesV1", "bookingCardModel"],
      "apps/web/src/components/PresentationV1.tsx": ["Gallery: PresentationGalleryV1"],
      "apps/web/src/components/ui.tsx": ["NoticeV1", "SectionHeadingV1", "buttonClassV1"],
    } as const;
    for (const [file, markers] of Object.entries(consumers)) {
      const source = await readFile(resolve(repoDir, file), "utf8");
      for (const marker of markers) expect(source, `${file}: ${marker}`).toContain(marker);
    }
  });

  it("maps booking cards without calling a client-module function from the server", async () => {
    const dates = <div>Synthetic dates</div>;
    const model = bookingCardModel({ slug: "synthetic-workshop", price: "¥4,000", priceIsFrom: false, childNote: null, schedule: null, canBook: true, assurances: [], preferredOfferId: "synthetic-offer" }, dates);
    expect(model.bookingHref).toBe("/experiences/synthetic-workshop/book?offer=synthetic-offer");
    expect(model.dates).toBe(dates);
    expect(model).not.toHaveProperty("childNote");
    const server = await readFile(resolve(repoDir, "apps/web/src/components/pages/ExperiencePageContent.tsx"), "utf8");
    const client = await readFile(resolve(repoDir, "apps/web/src/components/DetailBooking.tsx"), "utf8");
    const neutral = await readFile(resolve(repoDir, "apps/web/src/lib/presentation-booking-model.ts"), "utf8");
    expect(server).toContain('import { bookingCardModel } from "@/lib/presentation-booking-model"');
    expect(server).toContain("<BookingDatesController summary={booking} />");
    expect(client).not.toContain("export function bookingCardModel");
    expect(neutral).not.toContain('"use client"');
  });

  it("renders ready booking dates with the rich price message", () => {
    const html = renderToStaticMarkup(<DetailBookingDatesV1 state="ready" provisional={false} dates={[{ id: "synthetic-date", href: "/experiences/synthetic/book", ariaLabel: "Book synthetic date", weekday: "Fri", day: "23 Oct", time: "6:00 PM", option: "Synthetic option", price: "¥4,000" }]} />);
    expect(html).toContain("¥4,000");
    expect(html).toContain("/ adult");
    expect(html).not.toContain("{em}");
  });

  it("keeps the canonical 239-key copy registry literal and placeholder-safe", () => {
    expect(Object.keys(COPY_REGISTRY_V1)).toHaveLength(239);
    expect(() => createCopyV1({ ...EN_COPY_V1.values, "meta.titleTemplate": "NIHO" })).toThrow(/meta\.titleTemplate/);
    expect(() => createCopyV1({ ...EN_COPY_V1.values, "home.heroTitle": "<b>unsafe</b>" })).toThrow(/home\.heroTitle/);
    expect(EN_COPY_V1.text("card.fromPrice", { price: "¥4,000" })).toBe("From ¥4,000 / adult");
    expect(renderToStaticMarkup(<span>{EN_COPY_V1.text("card.fromPrice", { price: "<img src=x>" })}</span>)).toBe("<span>From &lt;img src=x&gt; / adult</span>");
    expect(Object.isFrozen(EN_COPY_V1.values)).toBe(true);
  });

  it("renders reordered rich messages and rejects missing, repeated, unknown or unbalanced protected markers", () => {
    expect(Object.keys(STATIC_COPY_REGISTRY_V1)).toHaveLength(342);
    expect(renderToStaticMarkup(<h1><RichMessageV1 segments={EN_STATIC_COPY_V1.rich("home.heroHeadingRich")} emphasisClassName="hand" /></h1>)).toBe('<h1>Meet the people who make Kamakura <span class="hand">home</span></h1>');
    const jaOrder = createStaticCopyV1({ ...defaultStaticCopyValuesV1(), "home.heroHeadingRich": "鎌倉を{em}家{/em}のように感じさせる人々に会う" });
    expect(renderToStaticMarkup(<h1><RichMessageV1 segments={jaOrder.rich("home.heroHeadingRich")} emphasisClassName="hand" /></h1>)).toBe('<h1>鎌倉を<span class="hand">家</span>のように感じさせる人々に会う</h1>');
    expect(renderToStaticMarkup(<span><RichMessageV1 segments={jaOrder.rich("detail.soldByRich", { seller: "{/em}<img src=x>" })} emphasisClassName="seller" /></span>)).toContain('<span class="seller">{/em}&lt;img src=x&gt;</span>');
    expect(() => createStaticCopyV1({ ...defaultStaticCopyValuesV1(), "home.heroHeadingRich": "鎌倉を家のように感じる" })).toThrow(/tokens/);
    expect(() => createStaticCopyV1({ ...defaultStaticCopyValuesV1(), "home.heroHeadingRich": "{em}家{/em}{em}home{/em}" })).toThrow(/tokens/);
    expect(() => createStaticCopyV1({ ...defaultStaticCopyValuesV1(), "home.heroHeadingRich": "鎌倉を{em}家" })).toThrow(/tokens|order/);
    expect(() => createStaticCopyV1({ ...defaultStaticCopyValuesV1(), "home.heroHeadingRich": "{strong}家{/strong}" })).toThrow(/marker|tokens/);
    expect(() => createStaticCopyV1({ ...defaultStaticCopyValuesV1(), "meta.titleTemplate": "NIHO Experience" })).toThrow(/tokens/);
    expect(() => createStaticCopyV1({ ...defaultStaticCopyValuesV1(), "meta.titleTemplate": "{title} · {title}" })).toThrow(/tokens/);
    const incomplete = { ...defaultStaticCopyValuesV1() } as Record<string, string>;
    delete incomplete["booking.fullName"];
    expect(() => createStaticCopyV1(incomplete as never)).toThrow(/incomplete/);
  });

  it("rejects unknown or tampered renderer identities", () => {
    expect(() => assertPresentationIdentityV1(PRESENTATION_MANIFEST_V1)).not.toThrow();
    expect(() => assertPresentationIdentityV1({ reactPeer: PRESENTATION_MANIFEST_V1.reactPeer, style: PRESENTATION_MANIFEST_V1.style, assets: PRESENTATION_MANIFEST_V1.assets, copy: PRESENTATION_MANIFEST_V1.copy, staticCopy: PRESENTATION_MANIFEST_V1.staticCopy, renderer: PRESENTATION_MANIFEST_V1.renderer })).not.toThrow();
    expect(() => assertPresentationIdentityV1({ ...PRESENTATION_MANIFEST_V1, renderer: "latest" })).toThrow(/tampered/);
    expect(() => assertPresentationIdentityV1({ ...PRESENTATION_MANIFEST_V1, extra: undefined })).toThrow(/tampered/);
  });

  it("exports exact schema-2 static metadata without a React runtime import", async () => {
    const metadataBytes = await readFile(resolve(packageDir, "dist/v1/static-copy-registry.json"));
    const metadata = JSON.parse(metadataBytes.toString());
    expect(metadata.schemaVersion).toBe(2);
    expect(metadata.legacySchemaVersion).toBe(1);
    expect(Object.keys(metadata.definitions)).toHaveLength(342);
    expect(sha256(metadataBytes)).toBe(PRESENTATION_MANIFEST_V1.staticCopy.sha256);
    expect(PRESENTATION_MANIFEST_V1.staticCopy).toEqual({ schemaVersion: 2, keyCount: 342, sha256: sha256(metadataBytes) });
    const pureModule = await readFile(resolve(packageDir, "dist/v1/metadata.js"), "utf8");
    expect(pureModule).not.toMatch(/from ["']react/);
  });

  it("ships scoped CSS and verified immutable decorative references", async () => {
    const css = await readFile(resolve(packageDir, "dist/v1/styles.css"), "utf8");
    expect(css).toContain("@scope (.nexp-v1)");
    expect(css).not.toMatch(/(^|\n)\s*(html|body)\s*\{/);
    const parsed = postcss.parse(css);
    parsed.walkRules((rule) => {
      let parent = rule.parent;
      let protectedByScopeOrDefinition = false;
      while (parent) {
        if (parent.type === "atrule" && (parent.name === "scope" || parent.name === "font-face" || parent.name.endsWith("keyframes"))) protectedByScopeOrDefinition = true;
        parent = parent.parent;
      }
      expect(protectedByScopeOrDefinition, `unscoped selector: ${rule.selector}`).toBe(true);
    });
    expect(sha256(css)).toBe(PRESENTATION_MANIFEST_V1.style.sha256);
    for (const [file, digest] of Object.entries(PRESENTATION_MANIFEST_V1.style.fonts)) expect(sha256(await readFile(resolve(packageDir, "dist/v1/fonts", file)))).toBe(digest);
    const bindings = defaultAssetBindingsV1();
    expect(() => assertAssetBindingsV1({ ...bindings, "home.hero": { ...bindings["home.hero"], srcset: "/sample/photos/niho-cd-table-02.jpg 1x" } })).not.toThrow();
    expect(() => assertAssetBindingsV1({ ...bindings, "home.hero": { ...bindings["home.hero"], src: "//example.invalid/unsafe.jpg" } })).toThrow(/asset binding/);
    for (const asset of Object.values(bindings)) {
      expect(sha256(await readFile(resolve(repoDir, "apps/web/public", asset.src.slice(1))))).toBe(asset.sha256);
      if (asset.kind === "video") expect(sha256(await readFile(resolve(repoDir, "apps/web/public", asset.poster.slice(1))))).toBe(asset.posterSha256);
    }
  });

  it("has no Next dependency or copied listing/host media and declares React 18/19 peers", async () => {
    const manifest = JSON.parse(await readFile(resolve(packageDir, "package.json"), "utf8"));
    const archive = resolve(packageDir, "dist/experience-presentation-v1.tgz");
    const packedManifest = JSON.parse(execFileSync("tar", ["-xOf", archive, "package/package.json"], { encoding: "utf8" }));
    expect(manifest.peerDependencies.react).toBe("^18.2.0 || ^19.0.0");
    expect(packedManifest.peerDependencies.react).toBe("^18.2.0 || ^19.0.0");
    expect(manifest.dependencies).toBeUndefined();
    expect(packedManifest.dependencies).toBeUndefined();
    expect(packedManifest.devDependencies).toBeUndefined();
    expect(packedManifest.scripts).toBeUndefined();
    expect(packedManifest.workspaces).toBeUndefined();
    expect({ ...manifest.dependencies, ...manifest.peerDependencies }).not.toHaveProperty("next");
    expect(packedManifest.files).toEqual(["dist/v1", "README.md"]);
    expect(packedManifest.exports).toEqual(manifest.exports);
    const packedFiles = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" }).trim().split("\n");
    expect(packedFiles.every((path) => path === "package/package.json" || path === "package/README.md" || path.startsWith("package/dist/v1/"))).toBe(true);
    expect(manifest.exports["./v1"].import).toBe("./dist/v1/index.js");
    expect(manifest.exports["./v1/styles.css"]).toBe("./dist/v1/styles.css");
    expect(manifest.exports["./v1/metadata"].import).toBe("./dist/v1/metadata.js");
    const distNames = await readdir(resolve(packageDir, "dist/v1"));
    expect(distNames.some((name) => /\.(?:jpe?g|png|webp|mp4)$/i.test(name))).toBe(false);
    const javascript = await Promise.all(distNames.filter((name) => name.endsWith(".js")).map((name) => readFile(resolve(packageDir, "dist/v1", name), "utf8")));
    expect(javascript.join("\n")).not.toContain("next/");
    expect(javascript.join("\n")).not.toContain("pilot-experiences");
    expect(javascript.join("\n")).not.toContain("dangerouslySetInnerHTML");
    expect(javascript.join("\n")).not.toMatch(/\beval\s*\(/);
  });

  it("rejects a tampered emitted file that was outside the old generated-file allowlist", async () => {
    const emitted = resolve(packageDir, "dist/v1/icons.js");
    const original = await readFile(emitted);
    try {
      await writeFile(emitted, Buffer.concat([original, Buffer.from("\n// tampered\n")]));
      expect(() => execFileSync(process.execPath, [resolve(packageDir, "scripts/build.mjs"), "--check"], { cwd: repoDir, stdio: "pipe" })).toThrow();
    } finally {
      await writeFile(emitted, original);
    }
  });
});
