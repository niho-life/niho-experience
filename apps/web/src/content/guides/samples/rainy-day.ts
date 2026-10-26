import type { Guide } from "../types";

/**
 * Synthetic sample guide for the mock preview only (registered in `../index.ts` as a sample, never with the real API).
 * It has no hero image, to show the page without one. Author and facts are invented.
 */
export const sampleRainyDay: Guide = {
  slug: "sample-rainy-day-in-kamakura",
  title: "Indoor crafts for a rainy day in Kamakura (sample guide)",
  description: "A sample guide for previews: indoor craft experiences for a wet day, and what to ask your host before you go. Everything in it is invented.",
  pillar: "hands-on",
  author: { name: "Ken Ito (sample)", role: "Sample writer, NIHO Experience (invented for previews)", bio: "Ken is an invented writer used only for the synthetic guide preview." },
  publishedAt: "2026-10-18",
  updatedAt: "2026-10-18",
  readMinutes: 4,
  relatedExperienceSlugs: ["indigo-dyeing-with-an-artisan", "evening-pottery-session"],
  relatedGuideSlugs: ["sample-first-evening-in-kamakura", "sample-kamakura-day-plan"],
  faq: [
    { question: "Do indoor experiences go ahead in the rain?", answer: "Craft experiences held in a studio usually do. Check the Good to know section of each experience." },
  ],
  body: `*This is a sample guide for previews. The hosts, studios and times in it are invented.*

A wet day is a good day to sit at a work table. Small studios take a few guests at a time, so you get the host's full attention.

## Crafts that work in any weather

- [Indigo dyeing](/experiences/indigo-dyeing-with-an-artisan): dye a cloth and watch the colour change in the air
- [Evening pottery](/experiences/evening-pottery-session): shape a cup at the wheel

## Questions to ask your host

Use the **Ask a question** button on the experience page if you are unsure about children, food or access.`,
};
