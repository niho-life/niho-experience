import type { HostPageContentCopy, HostPlanCopy, TitledText } from "./ja-service-copy";
import { HOST_PLANS } from "./ja-service-copy";

/** English copy for the shared host listing page. The Japanese plan definitions remain the source for the published rates. */
export const HOST_PAGE_EN = {
  eyebrow: "share your craft",
  title: "Share what you love about Kamakura",
  lead: "Open your workshop, teach something you know, or take guests along a favorite walk. Bring the work you already do to people who want to meet the town.",
  talk: "Talk with us",
  note: { title: "NIHO can look after guest communication", body: "We can handle questions, date changes, cancellations and refunds, so you can focus on hosting. You can review each request and decline it." },
  plansTitle: "Choose how to list each experience",
  rateLabel: "fee, including payment processing",
  you: "You",
  niho: "NIHO",
  switchNote: "You can move to a more independent plan later. We will confirm the terms for that experience before changing it.",
  stepsTitle: "From first conversation to your page",
  steps: [
    { title: "Tell us what you would like to share", body: "We will talk about the experience, who it is for and how often you would like to host." },
    { title: "Try it together", body: "We will take part once and think with you about a comfortable group size and schedule." },
    { title: "Agree on the details", body: "We will confirm your payout, group size, duration and what happens when a booking cannot go ahead." },
    { title: "Prepare and publish the page", body: "NIHO can help with photos and writing, and publish the page in Japanese and English." },
  ] satisfies readonly TitledText[],
  questionsTitle: "Common questions",
  questions: [
    { question: "Can I decline a booking request?", answer: "Yes. You do not need to give a reason. NIHO can let the guest know for you." },
    { question: "How is my payout decided?", answer: "We will set the guest price together from the amount you want to receive and the fee for your chosen plan. We confirm the terms for each experience in writing." },
    { question: "When do I get paid?", answer: "With Full service, NIHO closes the month when the experience takes place and pays you by the end of the following month. With Assisted or Independent, payment goes directly to your account." },
    { question: "Is keeping dates up to date difficult?", answer: "You can connect Google Calendar to stop bookings during events on your calendar. NIHO reads whether you are busy, not the event details." },
    { question: "I cannot host every week. Is that a problem?", answer: "A team can share responsibility for the same experience. The person who is available can host each booking." },
  ] satisfies readonly { question: string; answer: string }[],
  closing: { title: "Come by for a cup of tea", body: "You can decide whether to list your experience after we have talked." },
  loginLabel: "Sign in to your host page",
} satisfies HostPageContentCopy;

/** Rates and seller responsibilities mirror the owner-confirmed Japanese plans; only the wording is localized. */
export const HOST_PLANS_EN: readonly HostPlanCopy[] = [
  {
    id: "omakase", name: "Full service", rate: HOST_PLANS[0]!.rate, seller: "NIHO sells", highlight: true,
    lead: "NIHO creates the page, handles booking requests, guest messages and refunds. Share the dates you can host, then focus on the experience.",
    you: ["Share the dates you can host", "Welcome guests on the day"],
    niho: ["Create and publish the page", "Approve requests and contact guests", "Handle date changes, cancellations and refunds", "Collect payment, close at the end of the service month, and transfer by the end of the following month"],
  },
  {
    id: "support", name: "Assisted", rate: HOST_PLANS[1]!.rate, seller: "You sell", highlight: false,
    lead: "You sell the experience. When you need interpretation or help on the day, NIHO can find someone and coordinate with them.",
    you: ["Register your payout account and complete identity checks", "Set the price and terms", "Handle sales and refunds"],
    niho: ["Provide the listing, booking and payment tools", "Introduce and coordinate interpreters or day-of support", "Help with booking requests within the agreed scope"],
  },
  {
    id: "independent", name: "Independent", rate: HOST_PLANS[2]!.rate, seller: "You sell", highlight: false,
    lead: "Use the listing, booking and payment tools. Manage your dates and guest questions at your own pace.",
    you: ["Register your payout account and complete identity checks", "Manage the listing, dates and guest questions", "Handle changes, cancellations and refunds"],
    niho: ["Provide the listing, booking and payment tools", "Provide basic site support"],
  },
];
