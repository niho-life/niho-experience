import type { Guide } from "../types";

/** Synthetic planning guide for mock previews only. Every person, recommendation and timing is invented. */
export const sampleDayPlan: Guide = {
  slug: "sample-kamakura-day-plan",
  title: "A quiet Kamakura day plan from Tokyo (sample guide)",
  description: "A synthetic planning guide for previews: leave room between two small experiences and make the trip back without rushing.",
  pillar: "planning",
  author: {
    name: "Aya Mori (sample)",
    role: "Sample local writer (invented for previews)",
    bio: "Aya is an invented local writer used only to demonstrate the planning pillar in mock previews.",
  },
  publishedAt: "2026-10-19",
  updatedAt: "2026-10-22",
  checkedAt: "2026-10-22",
  readMinutes: 6,
  relatedExperienceSlugs: ["seaside-cycling-and-market-breakfast", "home-cooked-dinner-with-locals"],
  relatedGuideSlugs: ["sample-first-evening-in-kamakura", "sample-rainy-day-in-kamakura"],
  faq: [
    { question: "Is this a real itinerary?", answer: "No. It is synthetic preview content. Check each listed experience for its current details before booking." },
  ],
  body: `*This is a sample guide for previews. The route, people and timings in it are invented.*

A day feels easier when there is space between plans. Pick one thing for the morning, one for the evening, and keep the middle of the day open.

## Choose one anchor for the morning

Start with the [seaside cycling experience](/experiences/seaside-cycling-and-market-breakfast), then use its published duration and meeting details to plan the rest of the day.

## Leave the afternoon open

Walk, stop for lunch and avoid promising yourself three distant sights. Kamakura is compact, but small roads and busy stations can slow a short trip down.

## Check the evening before you travel

If you book the [home-cooked dinner](/experiences/home-cooked-dinner-with-locals), use the experience page for its current start time, price and directions.`,
};
