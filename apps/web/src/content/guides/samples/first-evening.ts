import type { Guide } from "../types";

/**
 * Synthetic sample guide for the mock preview only (registered in `../index.ts` as a sample, never with the real API).
 * Author, hosts and facts are invented and point at the synthetic fixture experiences. Not a published manuscript.
 */
export const sampleFirstEvening: Guide = {
  slug: "sample-first-evening-in-kamakura",
  title: "A first evening in Kamakura with local hosts (sample guide)",
  description: "A sample guide for previews: how an evening with local hosts works, what to bring and how to plan the trip back. Everything in it is invented.",
  author: { name: "Mika Sato (sample)", role: "Sample editor, NIHO Experience (invented for previews)" },
  publishedAt: "2026-10-20",
  updatedAt: "2026-10-24",
  hero: { src: "/placeholders/dinner.svg", alt: "Illustration of a long dinner table set for guests", width: 1200, height: 900, licensed: false },
  relatedExperienceSlugs: ["home-cooked-dinner-with-locals", "evening-pottery-session"],
  relatedGuideSlugs: ["sample-rainy-day-in-kamakura"],
  faq: [
    { question: "Do I need to speak Japanese?", answer: "No. The sample hosts in this guide explain each step in English, and you can ask questions at any time." },
    { question: "Can I come straight from Tokyo?", answer: "Yes. Leave enough time to find the meeting place: the booking email has the directions." },
    { question: "What if I have to cancel?", answer: "Each experience shows its own cancellation terms before you book. Read them on the experience page." },
  ],
  body: `*This is a sample guide for previews. The hosts, places and times in it are invented.*

Most day trips end when the temples close. An evening with people who live here is a different way to see the town: you cook, talk and eat at one table, and you leave knowing a few neighbours by name.

## How an evening works

Evening experiences are small. A host welcomes you, shows you around and gives everyone something to do. Read the **What you'll do** section of each experience to see the order of the evening.

### What to bring

- Comfortable clothes and socks: shoes often come off at the door
- A little cash for drinks that are not included
- Your booking email, which has the meeting point

### Before you book

1. Check the start time and how long it lasts.
2. Read the cancellation terms on the experience page.
3. Tell the host about allergies in the booking questions.

## Two evenings to start with

The [home-cooked dinner](/experiences/home-cooked-dinner-with-locals) is the easiest way in: everyone helps a little and nobody needs to be a good cook. If you would rather make something with your hands, the [evening pottery session](/experiences/evening-pottery-session) is quieter and *more hands-on*.

## Getting back

Plan your trip back before you arrive, so you can relax at the table. You can see every experience and its times on the [experiences page](/experiences).`,
};
