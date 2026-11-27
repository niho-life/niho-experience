"use client";

import { useEffect, useState } from "react";
import type { Occurrence } from "@niho-experience/api-client";
import { readBookingAvailability } from "@/lib/browser-availability";
import { bookingSourceFor, type BookingSources } from "@/lib/booking-source";
import { useSiteLocale } from "@/components/SiteLocale";

export type CardAvailability =
  /** Not asked for yet (the home reads only once the date picker is opened). */
  | { state: "idle" }
  | { state: "loading" }
  | { state: "failed" }
  | { state: "ready"; bySlug: Map<string, Occurrence[]> };

/**
 * Reads, in the browser, the availability of every card once (shared with other reads of the same slug), from where the server
 * says each experience is sold (#285). `enabled` false reads nothing yet. One failed read fails the whole read, so callers fail open.
 */
export function useCardAvailability(cards: readonly { readonly slug: string }[], preview: boolean, bookingSources: BookingSources, enabled = true): { availability: CardAvailability; retry: () => void } {
  const { locale, releaseId } = useSiteLocale();
  const [availability, setAvailability] = useState<CardAvailability>({ state: "loading" });
  const [attempt, setAttempt] = useState(0);
  // Keyed by the slugs, not the array: the list's cards are new objects after every address change, and a read is needed only for new experiences.
  const slugKey = cards.map((card) => card.slug).join("|");

  useEffect(() => {
    const slugs = slugKey ? slugKey.split("|") : [];
    if (!enabled || !slugs.length) return;
    let active = true;
    Promise.all(slugs.map((slug) => readBookingAvailability(slug, preview, bookingSourceFor(bookingSources, slug), locale, releaseId))).then((reads) => {
      if (!active) return;
      if (reads.some((read) => !read.ok)) {
        setAvailability({ state: "failed" });
        return;
      }
      const bySlug = new Map<string, Occurrence[]>();
      reads.forEach((read, index) => {
        if (read.ok) bySlug.set(slugs[index]!, read.occurrences);
      });
      setAvailability({ state: "ready", bySlug });
    });
    return () => {
      active = false;
    };
  }, [slugKey, preview, bookingSources, attempt, locale, releaseId, enabled]);

  return {
    availability: enabled ? availability : { state: "idle" },
    retry: () => {
      setAvailability({ state: "loading" });
      setAttempt((value) => value + 1);
    },
  };
}
