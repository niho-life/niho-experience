import { EN_STATIC_COPY_V1, HandIcon, SectionHeadingV1 } from "@niho/experience-presentation/v1";
import { PRESENTATION_PRIMITIVES_V1 } from "@/components/PresentationV1";
import { ButtonLink } from "@/components/ui";
import { ABOUT_EXTERIOR, ABOUT_HERO, ABOUT_PILLARS } from "@/lib/site-media";

const copy = EN_STATIC_COPY_V1;
const STEPS = [["cal", "home.pickDateTitle", "home.pickDateBody"], ["card", "home.payTitle", "home.payBody"], ["mail", "home.meetTitle", "home.meetBody"]] as const;

/** `/about` (#645): who NIHO Travel is made by. English only. NIHO's own photos, no animation. */
export function AboutPage() {
  const { Image, Link } = PRESENTATION_PRIMITIVES_V1;
  return <>
    <section className="relative" aria-label="About NIHO Travel">
      <div className="relative h-[380px] overflow-hidden bg-[#222] lg:h-[520px]">
        <Image src={ABOUT_HERO.src} alt={ABOUT_HERO.alt} priority sizes="100vw" className="absolute inset-0 h-full w-full object-cover" style={{ objectPosition: ABOUT_HERO.position }} />
        <div aria-hidden className="absolute inset-0 bg-[linear-gradient(180deg,rgb(0_0_0/0)_30%,rgb(0_0_0/0.62)_100%)]" />
        <div className="absolute inset-x-0 bottom-8 z-[2] text-white lg:bottom-14">
          <div className="container-page">
            <p className="hand text-[1.75rem] text-leaf">about</p>
            <h1 className="mt-1 max-w-[18ch] text-[2.25rem] leading-[1.05] [text-shadow:0_2px_18px_rgb(0_0_0/0.35)] lg:text-[3.75rem]">It starts in the town&rsquo;s living room</h1>
          </div>
        </div>
      </div>
    </section>

    <section className="container-page pt-12 lg:pt-20">
      <p className="max-w-[46rem] font-display text-[1.5rem] leading-snug lg:text-[2.125rem]">NIHO is a living room for Kamakura, two minutes from the station, where people of the town gather. NIHO Travel opens that room to travelers, with small experiences hosted by people who live here.</p>
    </section>

    <section className="container-page pt-12 lg:pt-20" aria-label="What we care about">
      <ul className="grid gap-9 md:grid-cols-3 md:gap-6 lg:gap-8">{ABOUT_PILLARS.map((pillar) => <li key={pillar.word}>
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
      <SectionHeadingV1 eyebrow={copy.text("home.bookingEyebrow")} title={copy.text("home.bookingTitle")} id="about-booking" />
      <ol className="grid gap-3 lg:grid-cols-3 lg:gap-4">{STEPS.map(([icon, title, body]) => <li key={title} className="flex items-start gap-4 rounded-[22px] bg-sand p-[22px]">
        <HandIcon name={icon} className="size-[46px]" />
        <div>
          <b className="block text-[1.0625rem]">{copy.text(title)}</b>
          <p className="mt-0.5 text-[0.9375rem] text-ink-soft">{copy.text(body)}</p>
        </div>
      </li>)}</ol>
      <p className="mt-6"><ButtonLink href="/experiences">See the experiences</ButtonLink></p>
    </section>

    <section className="container-page pt-16 lg:pt-24" aria-labelledby="about-who">
      <div className="grid items-center gap-8 md:grid-cols-2 md:gap-14">
        <div className="arch relative aspect-[4/5] w-[min(100%,360px)] justify-self-center bg-line md:justify-self-start">
          <Image src={ABOUT_EXTERIOR.src} alt={ABOUT_EXTERIOR.alt} sizes="(min-width: 48rem) 360px, 90vw" className="absolute inset-0 h-full w-full object-cover" />
        </div>
        <div>
          <p className="eyebrow">who runs it</p>
          <h2 id="about-who" className="mt-2 text-[1.875rem] lg:text-[2.625rem]">NIHO, the town&rsquo;s living room</h2>
          <p className="mt-3 text-ink-soft">NIHO Travel is made by NIHO, the town&rsquo;s living room, two minutes from Kamakura Station.</p>
          <p className="mt-4"><Link href="/help" className="link-leaf font-bold">Help and contact</Link></p>
        </div>
      </div>
    </section>

    <section className="container-page py-16 lg:py-24" aria-labelledby="about-locals">
      <div className="rounded-[28px] bg-leaf-pale px-6 py-8 lg:px-14 lg:py-12">
        <h2 id="about-locals" className="font-sans text-[1.25rem] font-extrabold tracking-normal">Live in Kamakura?</h2>
        <p className="mt-2 max-w-[40rem] text-ink-soft">{copy.text("home.localBody")}</p>
        <ButtonLink href="/host" variant="secondary" className="mt-5">{copy.text("home.learnHosting")}</ButtonLink>
      </div>
    </section>
  </>;
}
