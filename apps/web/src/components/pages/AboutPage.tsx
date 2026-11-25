import type { ReactNode } from "react";
import { EN_STATIC_COPY_V1, HandIcon, SectionHeadingV1 } from "@niho/experience-presentation/v1";
import { PRESENTATION_PRIMITIVES_V1 } from "@/components/PresentationV1";
import { ButtonLink } from "@/components/ui";
import { ABOUT_EXTERIOR, ABOUT_HERO, ABOUT_PILLARS } from "@/lib/site-media";

const copy = EN_STATIC_COPY_V1;

const STEPS = [["cal", "home.pickDateTitle", "home.pickDateBody"], ["card", "home.payTitle", "home.payBody"], ["mail", "home.meetTitle", "home.meetBody"]] as const;

type AboutPhoto = Readonly<{ src: string; alt: string; position?: string }>;

/** The words and links of the About page. English below; the Japanese site has its own in `lib/ja-about.ts` (#658). */
export type AboutContent = Readonly<{
  sectionLabel: string;
  hero: AboutPhoto;
  hand: string;
  title: ReactNode;
  lead: string;
  pillarsLabel: string;
  pillars: readonly Readonly<{ word: string; line: string; photo: AboutPhoto }>[];
  booking: Readonly<{ eyebrow: string; title: string; steps: readonly Readonly<{ icon: "cal" | "card" | "mail"; title: string; body: string }>[]; action: Readonly<{ href: string; label: string }> }>;
  who: Readonly<{ eyebrow: string; title: string; body: string; link: Readonly<{ href: string; label: string }>; photo: AboutPhoto }>;
  locals: Readonly<{ title: string; body: string; action: Readonly<{ href: string; label: string }> }>;
  /** Only the Japanese page sets these; the English classes stay as they were. */
  titleClassName?: string;
  leadClassName?: string;
  whoTitleClassName?: string;
}>;

export const ABOUT_CONTENT_EN: AboutContent = {
  sectionLabel: "About NIHO Travel",
  hero: ABOUT_HERO,
  hand: "about",
  title: <>It starts in the town&rsquo;s living room</>,
  lead: "NIHO is a living room for Kamakura, two minutes from the station, where people of the town gather. NIHO Travel opens that room to travelers, with small experiences hosted by people who live here.",
  pillarsLabel: "What we care about",
  pillars: ABOUT_PILLARS,
  booking: {
    eyebrow: copy.text("home.bookingEyebrow"),
    title: copy.text("home.bookingTitle"),
    steps: STEPS.map(([icon, title, body]) => ({ icon, title: copy.text(title), body: copy.text(body) })),
    action: { href: "/experiences", label: "See the experiences" },
  },
  who: { eyebrow: "who runs it", title: "NIHO, the town\u2019s living room", body: "NIHO Travel is made by NIHO, the town\u2019s living room, two minutes from Kamakura Station.", link: { href: "/help", label: "Help and contact" }, photo: ABOUT_EXTERIOR },
  locals: { title: "Live in Kamakura?", body: copy.text("home.localBody"), action: { href: "/host", label: copy.text("home.learnHosting") } },
};

/** `/about` (#645, Japanese since #658): who NIHO Travel is made by. NIHO's own photos, no animation. */
export function AboutPage({ content = ABOUT_CONTENT_EN }: { content?: AboutContent } = {}) {
  const { Image, Link } = PRESENTATION_PRIMITIVES_V1;
  const { hero, booking, who, locals } = content;
  return <>
    <section className="relative" aria-label={content.sectionLabel}>
      <div className="relative h-[380px] overflow-hidden bg-[#222] lg:h-[520px]">
        <Image src={hero.src} alt={hero.alt} priority sizes="100vw" className="absolute inset-0 h-full w-full object-cover" style={{ objectPosition: hero.position }} />
        <div aria-hidden className="absolute inset-0 bg-[linear-gradient(180deg,rgb(0_0_0/0)_30%,rgb(0_0_0/0.62)_100%)]" />
        <div className="absolute inset-x-0 bottom-8 z-[2] text-white lg:bottom-14">
          <div className="container-page">
            <p className="hand text-[1.75rem] text-leaf">{content.hand}</p>
            <h1 className={content.titleClassName ?? "mt-1 max-w-[18ch] text-[2.25rem] leading-[1.05] [text-shadow:0_2px_18px_rgb(0_0_0/0.35)] lg:text-[3.75rem]"}>{content.title}</h1>
          </div>
        </div>
      </div>
    </section>

    <section className="container-page pt-12 lg:pt-20">
      <p className={content.leadClassName ?? "max-w-[46rem] font-display text-[1.5rem] leading-snug lg:text-[2.125rem]"}>{content.lead}</p>
    </section>

    <section className="container-page pt-12 lg:pt-20" aria-label={content.pillarsLabel}>
      <ul className="grid gap-9 md:grid-cols-3 md:gap-6 lg:gap-8">{content.pillars.map((pillar) => <li key={pillar.word}>
        <figure>
          <div className="relative aspect-[4/5] overflow-hidden rounded-[var(--radius-card)] bg-sand">
            <Image src={pillar.photo.src} alt={pillar.photo.alt} sizes="(min-width: 48rem) 33vw, 100vw" className="absolute inset-0 h-full w-full object-cover" style={{ objectPosition: pillar.photo.position }} />
          </div>
          <figcaption className="mt-3.5">
            <span className="hand block text-[1.75rem] leading-none text-moss">{pillar.word}</span>
            <span className="mt-1 block text-[1.0625rem] font-bold">{pillar.line}</span>
          </figcaption>
        </figure>
      </li>)}</ul>
    </section>

    <section className="container-page pt-16 lg:pt-24" aria-labelledby="about-booking">
      <SectionHeadingV1 eyebrow={booking.eyebrow} title={booking.title} id="about-booking" />
      <ol className="grid gap-3 lg:grid-cols-3 lg:gap-4">{booking.steps.map((step) => <li key={step.title} className="flex items-start gap-4 rounded-[22px] bg-sand p-[22px]">
        <HandIcon name={step.icon} className="size-[46px]" />
        <div>
          <b className="block text-[1.0625rem]">{step.title}</b>
          <p className="mt-0.5 text-[0.9375rem] text-ink-soft">{step.body}</p>
        </div>
      </li>)}</ol>
      <p className="mt-6"><ButtonLink href={booking.action.href}>{booking.action.label}</ButtonLink></p>
    </section>

    <section className="container-page pt-16 lg:pt-24" aria-labelledby="about-who">
      <div className="grid items-center gap-8 md:grid-cols-2 md:gap-14">
        <div className="arch relative aspect-[4/5] w-[min(100%,360px)] justify-self-center bg-line md:justify-self-start">
          <Image src={who.photo.src} alt={who.photo.alt} sizes="(min-width: 48rem) 360px, 90vw" className="absolute inset-0 h-full w-full object-cover" />
        </div>
        <div>
          <p className="eyebrow">{who.eyebrow}</p>
          <h2 id="about-who" className={content.whoTitleClassName ?? "mt-2 text-[1.875rem] lg:text-[2.625rem]"}>{who.title}</h2>
          <p className="mt-3 text-ink-soft">{who.body}</p>
          <p className="mt-4"><Link href={who.link.href} className="link-leaf font-bold">{who.link.label}</Link></p>
        </div>
      </div>
    </section>

    <section className="container-page py-16 lg:py-24" aria-labelledby="about-locals">
      <div className="rounded-[28px] bg-leaf-pale px-6 py-8 lg:px-14 lg:py-12">
        <h2 id="about-locals" className="font-sans text-[1.25rem] font-extrabold tracking-normal">{locals.title}</h2>
        <p className="mt-2 max-w-[40rem] text-ink-soft">{locals.body}</p>
        <ButtonLink href={locals.action.href} variant="secondary" className="mt-5">{locals.action.label}</ButtonLink>
      </div>
    </section>
  </>;
}
