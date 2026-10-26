import type { ReactNode } from "react";
import { EN_STATIC_COPY_V1, type RichTextSegmentV1, type StaticCopyAccessorV1 } from "./static-copy.js";
import { ButtonLinkV1, DecorativeVideoV1, ExperienceCardV1, FigureV1, InviteCardV1, PhotoV1, PresentationRootV1, RichMessageV1, RubberStamp, SectionHeadingV1, buttonClassV1, FaceBadgeV1, HandIcon, type ExperienceCardModelV1, type HandIconName } from "./components.js";
import { BookingCheckoutViewV1, BookingSelectionViewV1, type BookingCheckoutViewModelV1, type BookingSelectionViewModelV1 } from "./booking-views.js";
import { DetailBookingCardV1, type DetailBookingCardModelV1 } from "./detail-booking.js";
import { primitivesV1, type DetailGalleryModelV1, type DisplayImageV1, type DisplayVideoV1, type FaceV1, type PresentationPrimitivesV1 } from "./types.js";
import { DetailGalleryV1 } from "./gallery.js";

export type HomeViewModelV1 = Readonly<{
  hero: DisplayImageV1;
  finder: ReactNode;
  themes: readonly { key: string; href: string; icon: HandIconName; label: string }[];
  cardsEyebrow?: string;
  cards: readonly { model: ExperienceCardModelV1; dates?: ReactNode }[];
  empty?: ReactNode;
  /** Consumer-owned editorial entry placed directly after the experience-card section. */
  afterCards?: ReactNode;
  feature?: { schedule?: string; heading: string; body: string; cta: string; href: string; photos: readonly DisplayImageV1[] };
  strips: readonly { key: string; href: string; verb: string; name: string; video: DisplayVideoV1 }[];
  stripsEyebrow: string;
  banner: DisplayVideoV1;
  hostFeature?: { headingEyebrow: string; headingTitle: string; moreHostsLabel: string; name: string; role?: string; story: string; cta: string; href: string; image?: DisplayImageV1; video?: DisplayVideoV1; faces: readonly { face: FaceV1; href: string; label: string; current: boolean }[] };
  figures: readonly { value: string; unit: string; note: string }[];
  postcards: readonly { id: string; image: DisplayImageV1; place: string; rotate: number }[];
  hostBand: DisplayVideoV1;
}>;

export function HomeViewV1({ model, primitives, copy = EN_STATIC_COPY_V1 }: { model: HomeViewModelV1; primitives?: Partial<PresentationPrimitivesV1>; copy?: StaticCopyAccessorV1 }) {
  const { Link, Image } = primitivesV1(primitives);
  const steps = [["cal", "home.pickDateTitle", "home.pickDateBody"], ["card", "home.payTitle", "home.payBody"], ["mail", "home.meetTitle", "home.meetBody"]] as const;
  return <>
    <section className="relative" aria-label={copy.text("home.welcome")}>
<div className="relative h-[560px] overflow-hidden bg-[#222] lg:h-[680px]">
      <Image src={model.hero.src} srcSet={model.hero.srcset} alt={model.hero.alt} priority sizes="100vw" className="absolute inset-0 h-full w-full object-cover" style={{ objectPosition: model.hero.position }} />
      <div aria-hidden className="absolute inset-0 bg-[linear-gradient(180deg,rgb(0_0_0/0)_32%,rgb(0_0_0/0.64)_100%)] lg:bg-[linear-gradient(90deg,rgb(0_0_0/0.42),rgb(0_0_0/0)_62%),linear-gradient(180deg,rgb(0_0_0/0)_40%,rgb(0_0_0/0.5)_100%)]" />
      <div className="absolute inset-x-0 bottom-16 z-[2] text-white lg:bottom-[116px]">
<div className="container-page">
<h1 className="max-w-[12ch] text-[2.625rem] leading-[1.02] [text-shadow:0_2px_18px_rgb(0_0_0/0.35)] lg:max-w-[13ch] lg:text-[4.875rem]"><RichMessageV1 segments={copy.rich("home.heroHeadingRich")} emphasisClassName="hand inline-block -rotate-3 text-[1.22em] text-leaf" />
</h1>
<p className="mt-3.5 max-w-[30rem] text-[1.0625rem] text-white/90 lg:text-[1.1875rem]">{copy.text("home.heroBody")}</p>
</div>
</div>
      <RubberStamp className="absolute top-[18px] right-4 z-[2] size-24 -rotate-12 text-white opacity-90 lg:top-11 lg:right-14 lg:size-[134px]" />
    </div>{model.finder}</section>
    {model.themes.length ? <nav aria-label={copy.text("home.themes")} className="scrollbar-none flex gap-0.5 overflow-x-auto px-3 pt-9 lg:justify-center lg:gap-7 lg:pt-[88px]">{model.themes.map((theme) => <Link key={theme.key} href={theme.href} className="flex w-[92px] shrink-0 flex-col items-center gap-2 rounded-[18px] px-1 py-2.5 text-center text-sm leading-tight font-bold text-ink-soft hover:bg-sand">
<HandIcon name={theme.icon} className="size-[46px] text-ink" />{theme.label}</Link>)}</nav> : null}
    <section className="container-page pt-14 lg:pt-[88px]" aria-labelledby="home-cards-v1">
<SectionHeadingV1 id="home-cards-v1" eyebrow={model.cardsEyebrow} title={<RichMessageV1 segments={copy.rich("home.hostedHeadingRich")} emphasisClassName="squig" />} action={model.cards.length ? <Link href="/experiences" className="link-leaf">{copy.text("home.seeAll")}</Link> : null} />
      {model.cards.length ? <ul className="scrollbar-none -mx-5 grid snap-x snap-mandatory auto-cols-[80%] grid-flow-col gap-[18px] overflow-x-auto px-5 pt-1 pb-7 sm:-mx-6 sm:auto-cols-[44%] sm:px-6 lg:mx-0 lg:grid-flow-row lg:grid-cols-3 lg:gap-x-7 lg:gap-y-[52px] lg:overflow-visible lg:p-0">{model.cards.map((card, index) => <li key={card.model.slug} className="snap-center">
<ExperienceCardV1 card={card.model} dates={card.dates} priority={index === 0} primitives={primitives} copy={copy} />
</li>)}<li className="snap-center">
<InviteCardV1 primitives={primitives} copy={copy} />
</li>
</ul> : model.empty ?? null}
    </section>{model.afterCards ?? null}
    {model.feature ? <section className="container-page pt-[72px] lg:pt-[104px]" aria-labelledby="featured-heading-v1">
<div className="grid items-center gap-7 lg:grid-cols-[0.9fr_1.3fr] lg:gap-16">
<div>{model.feature.schedule ? <p className="eyebrow">{model.feature.schedule}</p> : null}<h2 id="featured-heading-v1" className="mt-2 text-[2rem] lg:text-[2.75rem]">{model.feature.heading}</h2>
<p className="mt-3.5 max-w-[30rem] text-ink-soft">{model.feature.body}</p>
<ButtonLinkV1 href={model.feature.href} variant="secondary" className="mt-[22px]" primitives={primitives}>{model.feature.cta}</ButtonLinkV1>
</div>
<div className="grid h-80 grid-cols-[1fr_1fr_1.3fr] grid-rows-2 gap-1 overflow-hidden rounded-[22px] lg:h-[480px]">{model.feature.photos.slice(0, 5).map((photo, index) => <div key={`${photo.src}-${index}`} className={`relative min-h-0 ${index === 2 ? "col-start-3 row-span-2 row-start-1" : ""}`}>
<PhotoV1 image={photo} alt={photo.alt} primitives={primitives} sizes="(min-width: 64rem) 320px, 40vw" aspect="" rounded="" className="h-full" />
</div>)}</div>
</div>
</section> : null}
    {model.strips.length ? <section className="pt-[72px] lg:pt-[104px]" aria-labelledby="strips-heading-v1">
<div className="relative h-[340px] overflow-hidden bg-[#222] lg:h-[500px]">
<DecorativeVideoV1 video={model.banner} primitives={primitives} />
<div aria-hidden className="absolute inset-0 bg-black/35" />
<h2 id="strips-heading-v1" className="absolute inset-0 z-[1] flex flex-col items-center justify-center px-6 pb-[90px] text-center text-[2.125rem] text-white lg:pb-40 lg:text-[3.625rem]">{copy.text("home.slowTitle")}{" "}<span className="hand mt-2 block text-[0.86em] text-leaf">{model.stripsEyebrow}</span>
</h2>
</div>
<ul className="scrollbar-none relative z-[2] -mt-[110px] grid snap-x snap-mandatory auto-cols-[46%] grid-flow-col gap-2.5 overflow-x-auto px-5 sm:auto-cols-[30%] lg:mx-auto lg:-mt-[190px] lg:flex lg:max-w-[75rem] lg:justify-center lg:gap-3.5 lg:overflow-visible lg:px-10">{model.strips.map((strip) => <li key={strip.key} className="snap-start lg:w-[calc((100%_-_4*0.875rem)/5)]">
<Link href={strip.href} className="relative block aspect-[1/2] overflow-hidden rounded-[20px] bg-[#333] text-white">
<DecorativeVideoV1 video={strip.video} primitives={primitives} />
<span aria-hidden className="absolute inset-0 bg-[linear-gradient(180deg,rgb(0_0_0/0)_50%,rgb(0_0_0/0.66))]" />
<span className="absolute right-3 bottom-4 left-4 z-[1]">
<b className="hand block text-[2.375rem] text-white">{strip.verb}</b>
<small className="mt-0.5 block text-[0.8125rem] leading-snug font-bold text-white">{strip.name}</small>
</span>
</Link>
</li>)}</ul>
</section> : null}
    {model.hostFeature ? <HostFeatureV1 model={model.hostFeature} primitives={primitives} /> : null}
    {model.cards.length ? <section className="container-page pt-[72px] lg:pt-[104px]" aria-labelledby="numbers-heading-v1">
<SectionHeadingV1 align="center" eyebrow={copy.text("home.differentEyebrow")} title={copy.text("home.differentTitle")} id="numbers-heading-v1" />
<ul className="grid grid-cols-2 gap-x-3 gap-y-11 text-center lg:grid-cols-4">{model.figures.map((figure, index) => <FigureV1 key={`${figure.value}-${index}`} {...figure} />)}</ul>
</section> : null}
    <section className="container-page pt-[72px] lg:pt-[104px]" aria-labelledby="steps-heading-v1">
<SectionHeadingV1 eyebrow={copy.text("home.bookingEyebrow")} title={copy.text("home.bookingTitle")} id="steps-heading-v1" />
<ol className="grid gap-3 lg:grid-cols-3 lg:gap-4">{steps.map(([icon, title, body]) => <li key={title} className="flex items-start gap-4 rounded-[22px] bg-sand p-[22px]">
<HandIcon name={icon} className="size-[46px]" />
<div>
<b className="block text-[1.0625rem]">{copy.text(title)}</b>
<p className="mt-0.5 text-[0.9375rem] text-ink-soft">{copy.text(body)}</p>
</div>
</li>)}</ol>
<p className="mt-[18px] flex flex-wrap items-center justify-center gap-1 text-center">
<span className="hand text-[1.5625rem]">{copy.text("home.noAccount")}</span>
<HandIcon name="arrow" className="h-[34px] w-[60px] text-moss" />
</p>
</section>
    <section className="pt-[88px]" aria-labelledby="walk-heading-v1">
<div className="container-page">
<SectionHeadingV1 align="center" eyebrow={copy.text("home.aroundEyebrow")} title={copy.text("home.aroundTitle")} id="walk-heading-v1" />
</div>
<ul tabIndex={0} aria-label={copy.text("home.aroundPlaces")} className="scrollbar-none flex gap-[18px] overflow-x-auto px-5 pt-4 pb-7 lg:justify-center lg:gap-[26px] lg:pt-6">{model.postcards.map((card) => <li key={card.id} className="w-40 shrink-0 lg:w-45" style={{ transform: `rotate(${card.rotate}deg)` }}>
<figure>
<div className="postage postage-sm aspect-[3/4]">
<div className="postage-paper">
<PhotoV1 image={card.image} alt={card.image.alt} primitives={primitives} sizes="180px" aspect="" rounded="" className="h-full w-full" />
</div>
</div>
<figcaption className="mt-3 text-center font-hand text-2xl leading-[1.1] font-semibold">{card.place}</figcaption>
</figure>
</li>)}</ul>
</section>
    <section className="container-page pt-16" aria-labelledby="host-band-heading-v1">
<div className="grid items-center gap-7 overflow-hidden rounded-[28px] bg-sand px-6 py-8 lg:grid-cols-[1.2fr_0.8fr] lg:px-16 lg:py-14">
<div>
<p className="eyebrow">{copy.text("home.localEyebrow")}</p>
<h2 id="host-band-heading-v1" className="mt-2 text-[1.875rem] lg:text-[2.625rem]">{copy.text("home.localTitle")}</h2>
<p className="mt-3 text-ink-soft">{copy.text("home.localBody")}</p>
<ButtonLinkV1 href="/host" variant="secondary" className="mt-[22px]" primitives={primitives}>{copy.text("home.learnHosting")}</ButtonLinkV1>
</div>
<div className="arch relative aspect-[3/4] w-[min(100%,260px)] justify-self-center bg-line">
<DecorativeVideoV1 video={model.hostBand} primitives={primitives} />
</div>
</div>
</section>
  </>;
}

function HostFeatureV1({ model, primitives }: { model: NonNullable<HomeViewModelV1["hostFeature"]>; primitives?: Partial<PresentationPrimitivesV1> }) {
  const { Link } = primitivesV1(primitives);
  return <section className="mt-[72px] bg-sand pt-16 pb-[76px] lg:mt-[104px] lg:pt-24 lg:pb-[104px]" aria-labelledby="hosts-heading-v1">
<div className="container-page">
<SectionHeadingV1 align="center" eyebrow={model.headingEyebrow} title={model.headingTitle} id="hosts-heading-v1" />
<div className="grid items-center gap-11 lg:grid-cols-2 lg:gap-[72px]">
<div className="postage aspect-[4/5] w-[min(100%,380px)] justify-self-center lg:order-2 lg:w-[min(100%,420px)]">
<div className="postage-paper">{model.video ? <DecorativeVideoV1 video={model.video} primitives={primitives} /> : <PhotoV1 image={model.image ?? null} alt="" primitives={primitives} sizes="(min-width: 64rem) 420px, 90vw" aspect="" rounded="" className="h-full w-full" />}</div>
<RubberStamp className="absolute -bottom-[30px] -left-6 size-[124px] -rotate-[14deg] text-moss" />
</div>
<div>
<p className="hand text-[3.5rem]">{model.name}</p>{model.role ? <p className="mt-2 font-extrabold text-ink-soft">{model.role}</p> : null}<p className="mt-3.5 max-w-[30rem] text-ink-soft">{model.story}</p>
<ButtonLinkV1 href={model.href} variant="secondary" className="mt-6" primitives={primitives}>{model.cta}</ButtonLinkV1>{model.faces.length > 1 ? <ul className="mt-7 flex flex-wrap items-center gap-2.5" aria-label={model.moreHostsLabel}>{model.faces.map((entry) => <li key={`${entry.face.name}-${entry.href}`}>
<Link href={entry.href} aria-label={`${entry.face.name}: ${entry.label}`} className="block rounded-full">
<FaceBadgeV1 face={entry.face} primitives={primitives} className={`size-[46px] rounded-full border-[3px] text-lg ${entry.current ? "border-leaf" : `border-transparent ${entry.face.image ? "opacity-50 hover:opacity-100" : ""}`}`} sizes="46px" />
</Link>
</li>)}</ul> : null}</div>
</div>
</div>
</section>;
}

export function SiteHeaderV1({ primitives, copy = EN_STATIC_COPY_V1, currentPath, labels = {}, experiencesLink }: { primitives?: Partial<PresentationPrimitivesV1>; copy?: StaticCopyAccessorV1; currentPath?: string; labels?: { brand?: string; experiences?: string; host?: string; help?: string }; experiencesLink?: ReactNode }) {
  const { Link } = primitivesV1(primitives);
  return <header className="sticky top-0 z-30 border-b border-line bg-white/95 backdrop-blur-md backdrop-saturate-[1.2]">
<div className="container-page flex h-16 items-center gap-1.5">
<Link href="/" className="flex shrink-0 items-baseline gap-1.5 font-display text-xl font-semibold tracking-[-0.01em]">{labels.brand ? <span>{labels.brand}</span> : <RichMessageV1 segments={copy.rich("chrome.brandRich")} emphasisClassName="font-normal text-ink-soft max-[359px]:sr-only" />}</Link>
<nav aria-label={copy.text("chrome.main")} className="ml-auto">
<ul className="flex items-center gap-0.5 text-[0.9375rem] font-bold sm:gap-1">
<li>{experiencesLink ?? <Link href="/experiences" aria-current={currentPath === "/experiences" ? "page" : undefined} className={`rounded-full px-2.5 py-2 hover:bg-sand sm:px-3 ${currentPath === "/experiences" ? "bg-sand" : ""}`}>{labels.experiences ?? copy.text("chrome.experiences")}</Link>}</li>
<li className="hidden sm:block">
<Link href="/host" className="rounded-full px-3 py-2 hover:bg-sand">{labels.host || copy.text("chrome.host")}</Link>
</li>
<li className="hidden sm:block">
<Link href="/help" className="rounded-full px-3 py-2 hover:bg-sand">{labels.help ?? copy.text("chrome.help")}</Link>
</li>
</ul>
</nav>
<p className="shrink-0 rounded-full border border-line-strong px-2.5 py-1 text-[0.8125rem] font-extrabold whitespace-nowrap">
<span aria-hidden>{copy.text("chrome.localeCurrency")}</span>
<span className="sr-only">{copy.text("chrome.localeCurrencyLabel")}</span>
</p>
</div>
</header>;
}

/** Extra footer links after the fixed ones (e.g. the guides, only while some exist). The consumer supplies the label. */
export type FooterLinkV1 = Readonly<{ href: string; label: string }>;
export function SiteFooterV1({ primitives, copy = EN_STATIC_COPY_V1, previewNote, description, copyright, links = [] }: { primitives?: Partial<PresentationPrimitivesV1>; copy?: StaticCopyAccessorV1; previewNote?: ReactNode; description?: string; copyright?: string; links?: readonly FooterLinkV1[] }) {
  const { Link } = primitivesV1(primitives);
  return <footer className="mt-24 border-t border-line bg-white">
<div className={`container-page grid gap-7 pt-11 sm:grid-cols-[2fr_1fr_auto] sm:items-start ${previewNote ? "pb-10" : "pb-14"}`}>
<div className="max-w-md">
<p className="font-display text-xl font-semibold text-muted">{copy.text("chrome.brand")}</p>
<p className="mt-2 text-sm text-muted">{description ?? copy.text("chrome.footerDescription")}</p>{copyright ? <p className="mt-2 text-sm text-muted">{copyright}</p> : null}</div>
<nav aria-label={copy.text("chrome.footerNavigation")}>
<ul className="grid gap-2 text-sm font-bold">
<li>
<Link href="/experiences" className="hover:underline">{copy.text("chrome.footerExperiences")}</Link>
</li>
<li>
<Link href="/host" className="hover:underline">{copy.text("chrome.footerHost")}</Link>
</li>
<li>
<Link href="/help" className="hover:underline">{copy.text("chrome.footerBookingHelp")}</Link>
</li>{links.map((link) => <li key={link.href}>
<Link href={link.href} className="hover:underline">{link.label}</Link>
</li>)}
</ul>
</nav>
<RubberStamp className="size-[104px] rotate-[10deg] text-moss" />
</div>{previewNote ? <div className="container-page">{previewNote}</div> : null}</footer>;
}

export function SiteFrameV1({ children, header, footer, copy = EN_STATIC_COPY_V1 }: { children: ReactNode; header: ReactNode; footer: ReactNode; copy?: StaticCopyAccessorV1 }) {
  return <PresentationRootV1 className="flex min-h-dvh flex-col">
<a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-full focus:bg-ink focus:px-4 focus:py-2 focus:text-white">{copy.text("chrome.skipToContent")}</a>{header}<main id="main" className="flex-1">{children}</main>{footer}</PresentationRootV1>;
}

export function CatalogueViewV1({ heading, content, copy = EN_STATIC_COPY_V1 }: { heading?: string; content: ReactNode; copy?: StaticCopyAccessorV1 }) {
  return <div className="pt-9 sm:pt-14">
<header className="container-page">
<p className="eyebrow">{copy.text("catalogue.eyebrow")}</p>
<h1 className="mt-1.5 text-[2.5rem] sm:text-[3.625rem]">{heading ?? copy.text("catalogue.title")}</h1>
<p className="mt-2.5 text-[0.9375rem] text-muted">{copy.text("catalogue.priceTimeNote")}</p>
</header>{content}</div>;
}

export type HelpViewModelV1 = Readonly<{ primaryHref: string; primaryLabelKey: "help.niho" | "help.email"; emailHref: string; emailLabel: string }>;
export function HelpViewV1({ model, copy = EN_STATIC_COPY_V1 }: { model: HelpViewModelV1; copy?: StaticCopyAccessorV1 }) {
  const sections = [["help.beforeTitle", "help.beforeBody"], ["help.findTitle", "help.findBody"], ["help.changeTitle", "help.changeBody"]] as const;
  return <div className="container-page max-w-2xl py-10 sm:py-16">
<p className="eyebrow">{copy.text("help.eyebrow")}</p>
<h1 className="mt-2 text-4xl sm:text-5xl">{copy.text("help.title")}</h1>
<div className="mt-8 divide-y divide-line">{sections.map(([title, body]) => <section key={title} className="py-6">
<h2 className="text-2xl">{copy.text(title)}</h2>
<p className="mt-2 text-ink-soft">{copy.text(body)}</p>
</section>)}</div>
<div className="mt-6 flex flex-wrap items-center gap-4">
<a href={model.primaryHref} className={buttonClassV1("primary")}>{copy.text(model.primaryLabelKey)}</a>
<a href={model.emailHref} className="font-bold text-moss underline underline-offset-4">{model.emailLabel}</a>
</div>
</div>;
}

export type HostViewModelV1 = Readonly<{ video: DisplayVideoV1; steps: readonly { title: string; body: string }[]; you: readonly string[]; niho: readonly string[]; signup: ReactNode; signupOpen: boolean }>;
export function HostViewV1({ model, primitives, copy = EN_STATIC_COPY_V1 }: { model: HostViewModelV1; primitives?: Partial<PresentationPrimitivesV1>; copy?: StaticCopyAccessorV1 }) {
  return <div className="container-page pt-7 sm:pt-12">
<section className="grid items-center gap-6 lg:grid-cols-[1.2fr_0.8fr] lg:gap-16">
<header className="max-w-2xl">
<p className="eyebrow">{copy.text("host.peopleEyebrow")}</p>
<h1 className="mt-1.5 text-[2.25rem] sm:text-[3.5rem]">{copy.text("host.peopleTitle")}</h1>
<p className="mt-3 text-ink-soft sm:text-lg">{copy.text("host.peopleBody")}</p>
</header>
<div className="arch aspect-[3/4] w-[min(100%,280px)] justify-self-center bg-line">
<DecorativeVideoV1 video={model.video} primitives={primitives} />
</div>
</section>{model.signup}<section className="pt-14 lg:pt-[104px]" aria-labelledby="host-steps-v1">
<SectionHeadingV1 id="host-steps-v1" eyebrow={copy.text("host.howEyebrow")} title={copy.text("host.howTitle")} />
<ol className="grid lg:grid-cols-4">{model.steps.map((step, index) => <li key={step.title} className="flex items-start gap-4 border-dashed border-line-strong py-4 max-lg:border-b max-lg:last:border-b-0 lg:flex-col lg:gap-2.5 lg:border-l lg:px-7 lg:pt-1 lg:pb-2 lg:first:border-l-0 lg:first:pl-0">
<span className="w-7 shrink-0 text-center font-hand text-[2.5rem] leading-[0.9] font-bold text-moss lg:w-auto lg:text-left lg:text-[3.5rem]" aria-hidden>{index + 1}</span>
<div>
<h3 className="font-sans text-[1.0625rem] leading-snug font-extrabold tracking-normal">{step.title}</h3>
<p className="mt-0.5 text-[0.9375rem] text-ink-soft">{step.body}</p>
</div>
</li>)}</ol>
</section>
<section className="pt-14 lg:pt-[104px]" aria-labelledby="host-roles-v1">
<SectionHeadingV1 id="host-roles-v1" eyebrow={copy.text("host.rolesEyebrow")} title={copy.text("host.rolesTitle")} />
<div className="grid gap-3.5 md:grid-cols-2 lg:gap-5">
<RoleColumnV1 title={copy.text("host.you")} items={model.you} />
<RoleColumnV1 title={copy.text("host.niho")} items={model.niho} highlight />
</div>
</section>
<section className="max-w-2xl pt-14" aria-labelledby="host-money-v1">
<h2 id="host-money-v1" className="mb-4 text-[1.75rem] sm:text-[2rem]">{copy.text("host.fees")}</h2>
<div className="flex items-start gap-3.5 rounded-[22px] bg-sand p-5">
<HandIcon name="card" className="size-10 text-moss [stroke-width:1.5]" />
<p className="text-[0.9375rem] text-ink-soft">{copy.text("host.feesBody")}{model.signupOpen ? null : <> {copy.text("host.noCharge")}</>}</p>
</div>
</section>
<p className="mt-7 max-w-2xl">
<ButtonLinkV1 href="/experiences" variant={model.signupOpen ? "secondary" : "primary"} className="w-full lg:w-auto" primitives={primitives}>{copy.text("host.seeExperiences")}</ButtonLinkV1>
</p>
</div>;
}
function RoleColumnV1({ title, items, highlight = false }: { title: string; items: readonly string[]; highlight?: boolean }) { return <div className={`rounded-[22px] p-5 lg:p-8 ${highlight ? "bg-leaf-pale" : "bg-sand"}`}>
<h3 className="mb-2.5 font-sans text-sm font-extrabold tracking-[0.03em] text-muted uppercase">{title}</h3>
<ul className="space-y-2.5 text-[0.9375rem]">{items.map((item) => <li key={item} className="flex items-start gap-2.5">
<HandIcon name="check" className="-mt-px size-6 text-moss" />
<span>{item}</span>
</li>)}</ul>
</div>; }

/** `wide`: from lg the page uses the normal page width so the booking views can show their two-column desktop layout. */
export function BookingPageViewV1({ backHref, backLabel, backAccessibleLabel, panel, primitives, copy = EN_STATIC_COPY_V1, wide = false }: { backHref: string; backLabel: string; backAccessibleLabel?: string; panel: ReactNode; primitives?: Partial<PresentationPrimitivesV1>; copy?: StaticCopyAccessorV1; wide?: boolean }) {
  const { Link } = primitivesV1(primitives);
  return <div className={wide ? "container-page pb-6 max-lg:max-w-2xl" : "container-page max-w-2xl pb-6"}>
<Link href={backHref} aria-label={backAccessibleLabel ?? copy.text("booking.back")} className={`mt-[18px] inline-flex items-center gap-1.5 text-sm font-extrabold text-ink-soft hover:text-ink ${wide ? "lg:mt-8" : ""}`}>
<HandIcon name="back" className="size-[18px] [stroke-width:2.2]" />
<span aria-hidden>{backLabel}</span>
</Link>{panel}</div>;
}

export type BookingPreviewModelV1 = Readonly<{ selection: BookingSelectionViewModelV1; checkout: BookingCheckoutViewModelV1 }>;
export function BookingPreviewV1({ model, primitives, copy = EN_STATIC_COPY_V1 }: { model: BookingPreviewModelV1; primitives?: Partial<PresentationPrimitivesV1>; copy?: StaticCopyAccessorV1 }) {
  return <div className="space-y-16"><BookingSelectionViewV1 model={model.selection} primitives={primitives} copy={copy} /><BookingCheckoutViewV1 model={model.checkout} primitives={primitives} copy={copy} /></div>;
}

export type DetailMeetingModelV1 = Readonly<({ kind: "location"; name: string; address?: string; accessNote?: string; entranceNote?: string; mapUrl?: string; exterior?: DisplayImageV1 | null } | { kind: "after-booking" }) & { overview?: string }>;
export type DetailCancellationModelV1 = Readonly<{ policy?: { title: string; acceptanceNote: string }; sellerName: string; sellerLegalUrl?: string }>;
/** The one line under the title: "★ 4.9 · 12 reviews" (a link to the reviews), "2 reviews", or the "New" badge. The consumer supplies the strings. */
export type DetailReviewHeadlineV1 = Readonly<{ label: string; accessibleLabel?: string; href?: string; isNew?: boolean }>;
/** The reviews section (anchor `#reviews`): a heading and the consumer's content. Placed before the cancellation terms. */
export type DetailReviewsV1 = Readonly<{ title: string; content: ReactNode }>;
/** One structured participation condition ("Ages 10 and up" + a smaller line). The consumer supplies the display strings. */
export type DetailConditionV1 = Readonly<{ icon: HandIconName; headline: string; detail?: string }>;
/** A host's own introduction, shown as plain text under the host chips. The name is shown only when several hosts have one. */
export type DetailHostBioV1 = Readonly<{ name: string; text: string }>;
/** Questions and answers (anchor `#faq`): an h2, then one h3 per question and its plain-text answer, all in the server HTML. Placed before the cancellation terms. */
export type DetailFaqV1 = Readonly<{ title: string; items: readonly Readonly<{ question: string; answer: string }>[] }>;
export type DetailViewModelV1 = Readonly<{ title: string; backHref: string; gallery: DetailGalleryModelV1; schedule?: string; hosts: readonly FaceV1[]; hostLine: readonly RichTextSegmentV1[]; facts: readonly { icon: HandIconName; label: string; main: string; sub?: string | null }[]; lead: string; highlights: readonly { text: string; icon: HandIconName }[]; paragraphs: readonly string[]; timeline: readonly { time?: string; title: string; text: string; icon: HandIconName; photo?: DisplayImageV1 | null }[]; provider: { name: string; tagline?: string; photo?: DisplayImageV1 | null; hosts: readonly FaceV1[]; bios?: readonly DetailHostBioV1[] }; included: readonly string[]; notIncluded: readonly string[]; emptyListLabel: string; meeting: DetailMeetingModelV1; know: readonly string[]; showAllKnowLabel: string; notSuitable: readonly string[]; cancellation: DetailCancellationModelV1; booking?: DetailBookingCardModelV1; checkoutCancelled?: ReactNode; conditions?: readonly DetailConditionV1[]; askHost?: ReactNode; reviewHeadline?: DetailReviewHeadlineV1; reviews?: DetailReviewsV1; upcoming?: ReactNode; video?: ReactNode; faq?: DetailFaqV1 }>;
export function DetailViewV1({ model, primitives, copy = EN_STATIC_COPY_V1, headings = {} }: { model: DetailViewModelV1; primitives?: Partial<PresentationPrimitivesV1>; copy?: StaticCopyAccessorV1; headings?: { overview?: string; details?: string } }) {
  const { Link } = primitivesV1(primitives);
  const Gallery = primitives?.Gallery;
  const gallery = Gallery ? <Gallery model={model.gallery} /> : <DetailGalleryV1 model={model.gallery} primitives={primitives} copy={copy} />;
  // Keep the cancelled-checkout action after gallery controls in the DOM; on phones both move ahead of the heading to keep visual and tab order aligned.
  return <div className="flex flex-col overflow-x-clip"><div className="container-page">
<nav aria-label={copy.text("detail.breadcrumbNavigation")} className="hidden pt-7 text-sm text-muted lg:block">
<Link href={model.backHref} className="font-extrabold text-ink hover:underline">{copy.text("detail.breadcrumb")}</Link>
<span aria-hidden> / </span>
<span aria-current="page">{model.title}</span>
</nav><header className="pt-5 lg:pt-3.5">{model.schedule ? <p className="eyebrow">{model.schedule}</p> : null}<h1 className="mt-1.5 text-[2.125rem] leading-[1.1] lg:max-w-[20ch] lg:text-[3.25rem]">{model.title}</h1>{model.reviewHeadline ? <p className="mt-3 text-[0.9375rem] font-extrabold text-ink">{model.reviewHeadline.isNew ? <span className="inline-flex items-center rounded-full bg-leaf-pale px-2.5 py-0.5 text-[0.78125rem] font-extrabold text-moss">{model.reviewHeadline.label}</span> : model.reviewHeadline.href ? <a href={model.reviewHeadline.href} aria-label={model.reviewHeadline.accessibleLabel} className="underline-offset-4 hover:underline">{model.reviewHeadline.label}</a> : <span>{model.reviewHeadline.label}</span>}</p> : null}{model.upcoming ?? null}
<div className="mt-4 flex flex-wrap items-center gap-2.5 text-[0.9375rem] text-ink-soft">
<span className="flex">{model.hosts.map((face, index) => <FaceBadgeV1 key={`${face.name}-${index}`} face={face} primitives={primitives} className={`size-[38px] rounded-full border-2 border-white text-sm ${index ? "-ml-2.5" : ""}`} sizes="38px" />)}</span><span><RichMessageV1 segments={model.hostLine} emphasisClassName="font-extrabold text-ink" /></span></div>
<ul className="mt-[18px] grid grid-cols-2 gap-x-3 gap-y-4 border-y border-line py-[18px] lg:mt-[22px] lg:flex lg:flex-wrap lg:gap-x-9 lg:border-0 lg:py-0">{model.facts.map((fact) => <li key={fact.label} className="flex items-center gap-2.5 text-[0.9375rem] leading-tight font-extrabold">
<HandIcon name={fact.icon} className="size-8" />
<div>
<span className="sr-only">{fact.label}: </span>{fact.main}{fact.sub ? <small className="block text-[0.78125rem] font-bold text-muted">{fact.sub}</small> : null}</div>
</li>)}</ul>
</header></div>{model.video ? <div className="container-page py-6"><div className="max-w-[46rem]">{model.video}</div></div> : null}<div className="order-first lg:order-none lg:mx-auto lg:w-full lg:max-w-[75rem] lg:px-10">{gallery}</div>{model.checkoutCancelled ? <div className="container-page order-first lg:order-none">{model.checkoutCancelled}</div> : null}<div className="container-page"><div className={model.booking ? "grid gap-10 pt-6 lg:grid-cols-[minmax(0,1fr)_380px] lg:gap-[72px] lg:pt-4" : "grid gap-10 pt-6 lg:pt-4"}>
<div className="min-w-0">
<section className="pt-6" aria-label={copy.text("detail.overview")}>
<p className="text-lg leading-relaxed">{model.lead}</p>{model.highlights.length ? <ul className="mt-6 grid gap-3.5">{model.highlights.map((item) => <li key={item.text} className="flex items-center gap-3.5">
<HandIcon name={item.icon} className="size-10" />{item.text}</li>)}</ul> : null}</section>
<DetailSectionV1 title={headings.overview ?? copy.text("detail.whatYouDo")}>
<div className="space-y-3.5 text-ink-soft">{model.paragraphs.slice(0, 2).map((paragraph, index) => <p key={index}>{paragraph}</p>)}</div>{model.paragraphs.length > 2 ? <details className="group mt-4">
<summary className="link-leaf w-max cursor-pointer list-none [&::-webkit-details-marker]:hidden">
<span className="group-open:hidden">{copy.text("detail.readMore")}</span>
<span className="hidden group-open:inline">{copy.text("detail.showLess")}</span>
</summary>
<div className="mt-3.5 space-y-3.5 text-ink-soft">{model.paragraphs.slice(2).map((paragraph, index) => <p key={index}>{paragraph}</p>)}</div>
</details> : null}</DetailSectionV1>{model.timeline.length ? <DetailSectionV1 title={headings.details ?? copy.text("detail.timeline")}>
<ol>{model.timeline.map((step, index) => <li key={index} className="relative grid grid-cols-[96px_1fr] gap-4 pb-[22px] lg:grid-cols-[130px_1fr] lg:gap-[22px]">{index < model.timeline.length - 1 ? <span aria-hidden className="absolute top-[102px] bottom-1 left-12 border-l-2 border-dashed border-line-strong lg:top-[136px] lg:left-[65px]" /> : null}{step.photo ? <PhotoV1 image={step.photo} alt={step.photo.alt} primitives={primitives} aspect="" rounded="rounded-[18px]" className="size-24 lg:size-[130px]" sizes="130px" /> : <span className="grid size-24 place-items-center rounded-[18px] bg-sand lg:size-[130px]">
<HandIcon name={step.icon} className="size-[42px]" />
</span>}<div>{step.time ? <p className="hand text-[1.5625rem]">{step.time}</p> : null}<h3 className="mt-1 font-sans text-[1.0625rem] leading-[1.6] font-extrabold tracking-normal">{step.title}</h3>
<p className="mt-0.5 text-[0.9375rem] text-ink-soft">{step.text}</p>
</div>
</li>)}</ol>
</DetailSectionV1> : null}<DetailSectionV1 title={model.provider.hosts.length > 1 ? copy.text("detail.hosts") : model.provider.hosts.length ? copy.text("detail.host") : copy.text("detail.whoRuns")}>
<div className={`grid items-center gap-[30px] sm:gap-10 ${model.provider.photo ? "sm:grid-cols-[300px_1fr]" : "sm:grid-cols-[140px_1fr]"}`}>
{model.provider.photo ? <div className="postage aspect-[5/4] w-[min(100%,320px)] justify-self-center">
<div className="postage-paper [--pad:11px]">
<PhotoV1 image={model.provider.photo} alt="" primitives={primitives} sizes="320px" aspect="" rounded="" className="h-full w-full" />
</div>
<RubberStamp className="absolute -right-3 -bottom-[26px] size-[100px] -rotate-[14deg] text-moss" />
</div> : <RubberStamp className="size-[132px] -rotate-[10deg] justify-self-center text-moss sm:justify-self-start" />}
<div>{model.provider.tagline ? <p className="hand text-[1.8125rem] leading-[1.12]">“{model.provider.tagline}”</p> : null}<p className="mt-3 text-ink-soft"><RichMessageV1 segments={copy.rich("detail.offeredByRich", { provider: model.provider.name })} emphasisClassName="font-extrabold text-ink" /></p>
{model.provider.hosts.length ? <ul className="mt-4 flex flex-wrap gap-2">{model.provider.hosts.map((host, index) => <li key={`${host.name}-${index}`} className="flex items-center gap-2 rounded-full bg-sand py-1 pr-3.5 pl-1 text-sm font-extrabold"><FaceBadgeV1 face={host} primitives={primitives} className="size-8 rounded-full text-[0.8125rem]" sizes="32px" />{host.name}</li>)}</ul> : null}{model.provider.bios?.length ? <div className="mt-5 space-y-3 text-ink-soft">{model.provider.bios.map((bio, index) => <p key={`${bio.name}-${index}`} className="leading-relaxed whitespace-pre-line">{model.provider.bios!.length > 1 ? <><b className="font-extrabold text-ink">{bio.name}</b>{" · "}</> : null}{bio.text}</p>)}</div> : null}
</div>
</div>
</DetailSectionV1>
<DetailSectionV1 title={copy.text("detail.inclusions")}>
<div className="grid gap-[26px] sm:grid-cols-2">
<DetailListV1 title={copy.text("detail.included")} items={model.included} icon="check" emptyLabel={model.emptyListLabel} />
<DetailListV1 title={copy.text("detail.notIncluded")} items={model.notIncluded} icon="cross" emptyLabel={model.emptyListLabel} />
</div>
</DetailSectionV1>
<DetailSectionV1 title={copy.text("detail.meeting")}><DetailMeetingV1 model={model.meeting} primitives={primitives} copy={copy} /></DetailSectionV1>{model.know.length || model.notSuitable.length || model.conditions?.length ? <DetailSectionV1 title={copy.text("detail.goodToKnow")}>
{model.conditions?.length ? <DetailConditionsV1 items={model.conditions} /> : null}{model.know.length || !model.conditions?.length ? <DetailDotListV1 items={model.know.slice(0, 3)} className={model.conditions?.length ? "mt-6" : ""} /> : null}{model.know.length > 3 ? <details className="group mt-3"><summary className="link-leaf w-max cursor-pointer list-none [&::-webkit-details-marker]:hidden"><span className="group-open:hidden">{model.showAllKnowLabel}</span><span className="hidden group-open:inline">{copy.text("detail.showFewer")}</span></summary><div className="mt-3"><DetailDotListV1 items={model.know.slice(3)} /></div></details> : null}{model.notSuitable.length ? <div className="mt-[26px]">
<DetailListV1 title={copy.text("detail.notSuitable")} items={model.notSuitable} icon="cross" emptyLabel={model.emptyListLabel} />
</div> : null}{model.askHost ? <div className="mt-6">{model.askHost}</div> : null}</DetailSectionV1> : model.askHost ? <div className="pt-8">{model.askHost}</div> : null}{model.reviews ? <DetailSectionV1 id="reviews" title={model.reviews.title}>{model.reviews.content}</DetailSectionV1> : null}{model.faq?.items.length ? <DetailSectionV1 id="faq" title={model.faq.title}><div className="border-t border-line">{model.faq.items.map((item, index) => <div key={`${item.question}-${index}`} className="border-b border-line py-4"><h3 className="font-sans text-[1.0625rem] leading-[1.5] font-extrabold tracking-normal">{item.question}</h3><p className="mt-1.5 whitespace-pre-line text-ink-soft">{item.answer}</p></div>)}</div></DetailSectionV1> : null}<DetailSectionV1 title={copy.text("detail.cancellation")}><DetailCancellationV1 model={model.cancellation} copy={copy} /></DetailSectionV1>
</div>{model.booking ? <aside id="book" aria-labelledby="book-heading" className="hidden lg:sticky lg:top-[88px] lg:block lg:self-start lg:pt-12"><DetailBookingCardV1 model={model.booking} primitives={primitives} copy={copy} /></aside> : null}</div>
</div>
</div>;
}
function DetailSectionV1({ title, children, id }: { title: string; children: ReactNode; id?: string }) { return <section id={id} className={id ? "scroll-mt-24 pt-12" : "pt-12"}>
<h2 className="mb-[18px] text-[1.75rem] lg:text-[2rem]">{title}</h2>{children}</section>; }
function DetailListV1({ title, items, icon, emptyLabel }: { title: string; items: readonly string[]; icon: HandIconName; emptyLabel: string }) { return <div>
<h3 className="mb-3 font-sans text-sm font-extrabold tracking-[0.04em] text-muted uppercase">{title}</h3>
{items.length ? <ul className="space-y-2.5">{items.map((item) => <li key={item} className="flex items-start gap-2.5">
<HandIcon name={icon} className={`mt-px size-[26px] ${icon === "check" ? "text-moss" : "text-muted"}`} />{item}</li>)}</ul>
 : <p className="text-muted">{emptyLabel}</p>}
</div>; }
function DetailDotListV1({ items, className = "" }: { items: readonly string[]; className?: string }) { return <ul className={`space-y-2.5 text-ink-soft${className ? ` ${className}` : ""}`}>{items.map((item) => <li key={item} className="flex gap-3"><span aria-hidden className="mt-[0.6em] size-[7px] shrink-0 rounded-full bg-leaf" /><span>{item}</span></li>)}</ul>; }
function DetailConditionsV1({ items }: { items: readonly DetailConditionV1[] }) { return <ul className="border-t border-line">{items.map((item) => <li key={item.headline} className="flex items-start gap-3.5 border-b border-line py-3.5"><HandIcon name={item.icon} className="mt-0.5 size-8 shrink-0" /><div className="min-w-0"><b className="block font-extrabold">{item.headline}</b>{item.detail ? <small className="block text-[0.9375rem] text-ink-soft">{item.detail}</small> : null}</div></li>)}</ul>; }
function DetailMeetingV1({ model, primitives, copy }: { model: DetailMeetingModelV1; primitives?: Partial<PresentationPrimitivesV1>; copy: StaticCopyAccessorV1 }) {
  const overview = model.overview ? <p className="mb-4 leading-relaxed text-ink-soft">{model.overview}</p> : null;
  if (model.kind === "after-booking") return <>{overview}<p className="flex items-center gap-2"><HandIcon name="pin" className="size-7 text-moss" />{copy.text("detail.meetingAfterBooking")}</p></>;
  return <>{overview}<div className={`grid items-start gap-5 ${model.exterior ? "sm:grid-cols-[200px_1fr] sm:gap-7" : ""}`}>{model.exterior ? <div className="arch relative aspect-[3/4] w-[190px] sm:w-[200px]"><PhotoV1 image={model.exterior} alt={model.exterior.alt} primitives={primitives} aspect="" rounded="" className="h-full w-full" sizes="200px" /></div> : null}<div><p className="text-[1.0625rem] font-extrabold">{model.name}</p>{model.address ? <p className="mt-1.5 text-[0.96875rem] text-ink-soft">{model.address}</p> : null}{model.accessNote ? <p className="mt-3 flex items-center gap-2 font-extrabold"><HandIcon name="train" className="size-[30px]" />{model.accessNote}</p> : null}{model.entranceNote ? <p className="mt-1.5 text-[0.96875rem] text-ink-soft">{model.entranceNote}</p> : null}{model.mapUrl ? <a href={model.mapUrl} rel="noopener noreferrer" className="link-leaf mt-3.5 inline-block text-[0.9375rem]">{copy.text("detail.openMaps")}</a> : null}</div></div></>;
}
function DetailCancellationV1({ model, copy }: { model: DetailCancellationModelV1; copy: StaticCopyAccessorV1 }) {
  return <>{model.policy ? <div className="flex items-start gap-3.5 rounded-[22px] bg-sand p-5"><HandIcon name="umbrella" className="size-[38px] text-moss" /><div><p className="text-[1.0625rem] font-extrabold">{model.policy.title}</p><p className="mt-1 text-[0.9375rem] text-ink-soft">{model.policy.acceptanceNote}</p></div></div> : <p>{copy.text("detail.cancellationChoose")}</p>}<p className="mt-3.5 text-sm text-muted"><RichMessageV1 segments={copy.rich("detail.soldByRich", { seller: model.sellerName })} emphasisClassName="font-extrabold text-ink" />{model.sellerLegalUrl ? <> · <a href={model.sellerLegalUrl} className="font-extrabold text-ink underline" rel="noopener noreferrer">{copy.text("detail.sellerInfo")}</a></> : null}</p></>;
}
