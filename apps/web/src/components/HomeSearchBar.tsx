"use client";

import { useState } from "react";
import type { BookingSources } from "@/lib/booking-source";
import { useCardAvailability } from "@/lib/use-card-availability";
import { ExperienceSearchBar, type SearchBarCard } from "./ExperienceSearchBar";

/**
 * The home's search bar (#698), over the hero's bottom edge. The home has no list state, so the choices stay in the bar and
 * 「さがす」 opens the list with them. Availability for the calendar's marks is read lazily, over every card the page has,
 * only once the day picker (or the phone sheet) is first opened: most visitors never open it, so the home reads nothing by default.
 */
export function HomeSearchBar({ locale, cards, windowStart, windowEnd, preview, bookingSources }: {
  locale: "en" | "ja";
  cards: readonly SearchBarCard[];
  windowStart: string;
  windowEnd: string;
  preview: boolean;
  bookingSources: BookingSources;
}) {
  const [wanted, setWanted] = useState(false);
  const { availability } = useCardAvailability(cards, preview, bookingSources, wanted);
  return (
    <ExperienceSearchBar
      locale={locale}
      mode="navigate"
      placement="hero"
      windowStart={windowStart}
      windowEnd={windowEnd}
      cards={cards}
      availability={availability.state === "ready" ? availability.bySlug : null}
      onNeedAvailability={() => setWanted(true)}
    />
  );
}
