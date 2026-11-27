import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { CardModel } from "@/lib/card-model";
import { SiteLocaleProvider } from "./SiteLocale";

vi.mock("next/navigation", () => ({ usePathname: () => "/experiences", useRouter: () => ({ push: vi.fn() }), useSearchParams: () => new URLSearchParams() }));
import { ExperienceCard } from "./ExperienceCard";

const card = (over: Partial<CardModel> = {}): CardModel => ({
  slug: "synthetic", title: "Synthetic walk", lead: "Lead", cover: null, withLabel: "with Host", face: { name: "Host", initial: "H", image: null },
  groupLabel: null, durationLabel: "See details", language: null, scheduleLabel: null, priceLabel: "¥4,000", priceIsFrom: false, offers: [], ...over,
});
const html = (locale: "en" | "ja", model: CardModel) => renderToStaticMarkup(<SiteLocaleProvider locale={locale}><ExperienceCard card={model} /></SiteLocaleProvider>);

describe("ExperienceCard (#706)", () => {
  it("marks a page whose bookings are not open yet, in each language, and keeps its price and link", () => {
    const en = html("en", card({ bookingAvailable: false }));
    expect(en).toContain("Coming soon");
    expect(en).toContain("¥4,000");
    expect(en).toContain('href="/experiences/synthetic"');
    const ja = html("ja", card({ bookingAvailable: false }));
    expect(ja).toContain("受付準備中");
    expect(ja).toContain('href="/ja/experiences/synthetic"');
  });

  it("shows no mark for a bookable card, or a card from the NIHO side that says nothing", () => {
    expect(html("en", card({ bookingAvailable: true }))).not.toContain("Coming soon");
    expect(html("ja", card())).not.toContain("受付準備中");
  });
});
