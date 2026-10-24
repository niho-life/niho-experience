import type { ReactNode } from "react";
import { HandIcon, RubberStamp, type HandIconName } from "./icons.js";
import { EN_STATIC_COPY_V1, type RichTextSegmentV1, type StaticCopyAccessorV1 } from "./static-copy.js";
import { primitivesV1, type DisplayImageV1, type DisplayVideoV1, type FaceV1, type PresentationPrimitivesV1 } from "./types.js";

export const PRESENTATION_SCOPE_CLASS_V1 = "nexp-v1";

export function RichMessageV1({ segments, emphasisClassName = "" }: { segments: readonly RichTextSegmentV1[]; emphasisClassName?: string }) {
  return <>{segments.map((segment, index) => segment.emphasis ? <span key={index} className={emphasisClassName}>{segment.text}</span> : segment.text)}</>;
}

export function PresentationRootV1({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`${PRESENTATION_SCOPE_CLASS_V1} ${className}`}>{children}</div>;
}

export type ButtonVariantV1 = "primary" | "secondary" | "ghost";
const buttonBase = "inline-flex min-h-12 items-center justify-center gap-2 rounded-full px-6 text-base font-extrabold transition-colors disabled:cursor-not-allowed disabled:opacity-60";
const buttonVariants: Record<ButtonVariantV1, string> = {
  primary: "bg-leaf text-ink hover:bg-leaf-hover",
  secondary: "bg-transparent text-ink shadow-[inset_0_0_0_1.5px_var(--color-ink)] hover:bg-sand",
  ghost: "text-moss underline-offset-4 hover:underline",
};
export const buttonClassV1 = (variant: ButtonVariantV1 = "primary", extra = "") => `${buttonBase} ${buttonVariants[variant]} ${extra}`;

export function ButtonLinkV1({ href, children, variant = "primary", className = "", primitives }: { href: string; children: ReactNode; variant?: ButtonVariantV1; className?: string; primitives?: Partial<PresentationPrimitivesV1> }) {
  const { Link } = primitivesV1(primitives);
  return <Link href={href} className={buttonClassV1(variant, className)}>{children}</Link>;
}

export function SectionHeadingV1({ eyebrow, title, id, children, align = "start", action }: { eyebrow?: string; title: ReactNode; id?: string; children?: ReactNode; align?: "start" | "center"; action?: ReactNode }) {
  const centered = align === "center";
  return <div className={`mb-7 flex flex-wrap items-end gap-x-6 gap-y-3 ${centered ? "justify-center text-center" : "justify-between"}`}>
    <div className={`max-w-2xl ${centered ? "mx-auto" : ""}`}>
      {eyebrow ? <p className="eyebrow mb-1.5">{eyebrow}</p> : null}
      <h2 id={id} className="text-[2rem] sm:text-[2.75rem]">{title}</h2>
      {children ? <div className="mt-3 text-ink-soft">{children}</div> : null}
    </div>
    {action}
  </div>;
}

export function PhotoV1({ image, alt, sizes, priority = false, primitives, className = "", rounded = "rounded-[var(--radius-card)]", aspect = "aspect-[4/3]", imgClassName = "", emptyLabel = EN_STATIC_COPY_V1.text("common.imageComingSoon") }: { image: DisplayImageV1 | null; alt: string; sizes: string; priority?: boolean; primitives?: Partial<PresentationPrimitivesV1>; className?: string; rounded?: string; aspect?: string; imgClassName?: string; emptyLabel?: string }) {
  const { Image } = primitivesV1(primitives);
  return <div className={`relative overflow-hidden bg-sand ${aspect} ${rounded} ${className}`}>
    {image ? <Image src={image.src} srcSet={image.srcset} alt={alt} sizes={sizes} priority={priority} className={`absolute inset-0 h-full w-full object-cover ${imgClassName}`} style={{ objectPosition: image.position }} />
      : alt ? <span className="flex h-full items-center justify-center text-sm text-muted" role="img" aria-label={alt}>{emptyLabel}</span> : null}
  </div>;
}

export function FaceBadgeV1({ face, primitives, className = "size-10 rounded-full text-base", sizes = "64px" }: { face: FaceV1; primitives?: Partial<PresentationPrimitivesV1>; className?: string; sizes?: string }) {
  if (face.image) return <span aria-hidden className={`block overflow-hidden bg-sand ${className}`}><PhotoV1 image={face.image} alt="" sizes={sizes} primitives={primitives} aspect="" rounded="" className="h-full w-full" /></span>;
  return <span aria-hidden className={`grid place-items-center bg-leaf-pale font-extrabold text-moss ${className}`}>{face.initial}</span>;
}

export function DecorativeVideoV1({ video, primitives, className = "" }: { video: DisplayVideoV1; primitives?: Partial<PresentationPrimitivesV1>; className?: string }) {
  const { Video = primitivesV1().Video! } = primitivesV1(primitives);
  return <Video src={video.src} poster={video.poster} className={`h-full w-full object-cover ${className}`} />;
}

export function NoticeV1({ tone = "info", title, children, action, role, copy = EN_STATIC_COPY_V1 }: { tone?: "info" | "warn" | "danger" | "success" | "neutral"; title: string; children?: ReactNode; action?: ReactNode; role?: "status" | "alert"; copy?: StaticCopyAccessorV1 }) {
  const tones = {
    info: ["border-info/25 bg-info-pale text-info", "i", copy.text("notice.infoLabel")], warn: ["border-warn/25 bg-warn-pale text-warn", "!", copy.text("notice.warnLabel")],
    danger: ["border-danger/25 bg-danger-pale text-danger", "!", copy.text("notice.dangerLabel")], success: ["border-moss/25 bg-leaf-pale text-moss", "✓", copy.text("notice.successLabel")],
    neutral: ["border-line bg-sand text-ink-soft", "i", copy.text("notice.infoLabel")],
  } as const;
  const [box, icon, label] = tones[tone];
  return <div role={role} className={`flex gap-3 rounded-2xl border p-4 ${box}`}><span aria-hidden className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-current text-sm font-black"><span className="text-white mix-blend-normal">{icon}</span></span><div className="min-w-0 space-y-1"><p className="font-bold"><span className="sr-only">{label}: </span>{title}</p>{children ? <div className="text-ink-soft">{children}</div> : null}{action ? <div className="pt-2">{action}</div> : null}</div></div>;
}

export type BookingSummaryModelV1 = Readonly<{ title: string; image: DisplayImageV1 | null; summary?: string }>;
/** `aside`: inside a booking view's @container, from @4xl (56rem) the card turns into the right column's vertical summary (photo on top). */
export function BookingSummaryV1({ model, titleAs = "h1", primitives, aside = false, className = "" }: { model: BookingSummaryModelV1; titleAs?: "h1" | "p"; primitives?: Partial<PresentationPrimitivesV1>; aside?: boolean; className?: string }) {
  const Title = titleAs;
  return <div className={`mt-3.5 flex items-center gap-3.5 rounded-[20px] border border-line p-3 ${aside ? "@4xl:mt-[30px] @4xl:block @4xl:self-start @4xl:rounded-[26px] @4xl:p-4" : ""} ${className}`}><PhotoV1 image={model.image} alt="" sizes={aside ? "(min-width: 64rem) 348px, 72px" : "72px"} primitives={primitives} aspect="" rounded={aside ? "rounded-[14px] @4xl:rounded-2xl" : "rounded-[14px]"} className={aside ? "size-[72px] shrink-0 @4xl:aspect-[16/10] @4xl:h-auto @4xl:w-full" : "size-[72px] shrink-0"} /><div className={aside ? "min-w-0 @4xl:mt-3.5" : "min-w-0"}><Title className={`font-display text-lg leading-[1.2] font-[450] tracking-[-0.01em] text-ink ${aside ? "@4xl:text-[1.3125rem]" : ""}`}>{model.title}</Title>{model.summary ? <p className="mt-1 text-[0.84375rem] font-bold text-muted">{model.summary}</p> : null}</div></div>;
}

export function BookingStepHeadingV1({ id, step, label, children }: { id?: string; step: number; label: string; children: ReactNode }) {
  return <h2 id={id} className="mt-[30px] mb-3 text-[1.625rem] tracking-[-0.01em]"><span className="hand mb-1 block text-[1.375rem]">{label} {step}</span>{children}</h2>;
}

// As an aside card (@4xl) the bar is a column: total and date on top, the action below. The phone row layout never applies there.
function barLayout(stack: boolean, aside: boolean) {
  if (stack) return aside ? "flex-col min-[30rem]:@max-4xl:flex-row min-[30rem]:@max-4xl:items-center min-[30rem]:@max-4xl:justify-between" : "flex-col min-[30rem]:flex-row min-[30rem]:items-center min-[30rem]:justify-between";
  return aside ? "items-center justify-between @4xl:flex-col @4xl:items-stretch @4xl:justify-start" : "items-center justify-between";
}
/** `aside`: inside a booking view's @container, from @4xl the bottom bar becomes an in-flow card that sticks below the header (total and date on top, action below). */
export function BookingBarV1({ total, line, action, stack = false, aside = false, className = "" }: { total: ReactNode; line: ReactNode; action: ReactNode; stack?: boolean; aside?: boolean; className?: string }) {
  return <div data-sticky-bar className={`sticky bottom-0 z-20 -mx-5 mt-10 flex gap-x-3 gap-y-2.5 border-t border-line bg-white/95 px-5 pt-3 pb-3.5 backdrop-blur sm:-mx-6 sm:px-6 lg:-mx-10 lg:px-10 ${barLayout(stack, aside)} ${aside ? "@4xl:top-[88px] @4xl:bottom-auto @4xl:m-0 @4xl:mt-4 @4xl:gap-y-4 @4xl:self-start @4xl:rounded-[26px] @4xl:border @4xl:border-line @4xl:bg-white @4xl:p-[22px] @4xl:shadow-[0_12px_36px_rgb(0_0_0/0.08)] @4xl:backdrop-blur-none" : ""} ${className}`}><div className="min-w-0 leading-tight" aria-live="polite"><p className={`text-sm text-ink-soft ${aside ? "@4xl:text-[0.9375rem]" : ""}`}>{total}</p><p className={`mt-1 truncate text-[0.8125rem] font-extrabold text-moss ${aside ? "@4xl:text-sm @4xl:whitespace-normal" : ""}`}>{line}</p></div>{action}</div>;
}

export const BOOKING_FIELD_LABEL_CLASS_V1 = "mt-3.5 block text-[0.90625rem] font-extrabold";
export const BOOKING_FIELD_INPUT_CLASS_V1 = "mt-1.5 block min-h-[50px] w-full rounded-[14px] border border-line-strong bg-white px-3.5 py-3 text-base leading-snug font-normal text-ink focus-visible:border-transparent focus-visible:outline-offset-1 aria-[invalid=true]:border-danger";

export type ExperienceCardModelV1 = Readonly<{
  slug: string; href: string; cover: DisplayImageV1 | null; face: FaceV1; groupLabel: string | null; withLabel: string; title: string; lead: string;
  durationLabel: string; language: { short: string; full: string } | null; scheduleLabel: string | null; priceLabel: string; priceIsFrom: boolean; priceSuffix: string;
  /** "★ 4.9 · 12" and its spoken form. Only for experiences that have reviews (the average only from three). */
  reviewLine?: Readonly<{ text: string; label: string }>;
}>;

export function ExperienceCardV1({ card, dates, highlight = null, variant = "home", priority = false, primitives, copy = EN_STATIC_COPY_V1 }: { card: ExperienceCardModelV1; dates?: ReactNode; highlight?: string | null; variant?: "home" | "list"; priority?: boolean; primitives?: Partial<PresentationPrimitivesV1>; copy?: StaticCopyAccessorV1 }) {
  const { Link } = primitivesV1(primitives); const list = variant === "list";
  return <article className="group relative flex h-full min-w-0 flex-col"><div className="relative">
    <PhotoV1 image={card.cover} alt={card.cover?.alt || card.title} priority={priority} primitives={primitives} rounded="rounded-[var(--radius-card)]" aspect={list ? "aspect-[4/3] sm:aspect-[4/5]" : "aspect-[4/5]"} sizes="(min-width: 64rem) 380px, (min-width: 40rem) 50vw, 85vw" emptyLabel={copy.text("common.imageComingSoon")} />
    {card.groupLabel ? <span className="absolute top-3 left-3 rounded-full bg-white/95 px-3 py-1 text-[0.8125rem] font-extrabold text-ink">{card.groupLabel}</span> : null}
    <FaceBadgeV1 face={card.face} primitives={primitives} className="absolute right-3.5 -bottom-6 size-16 rounded-[18px] border-[3px] border-white text-2xl shadow-[0_6px_16px_rgb(0_0_0/0.14)]" />
  </div><div className="flex flex-1 flex-col pt-3"><p className="min-h-[1.375rem] pr-20 text-sm font-bold text-muted">{card.withLabel}</p>
    <h3 className="mt-1 text-[1.375rem] leading-[1.18]"><Link href={card.href} className="bg-[linear-gradient(var(--color-leaf),var(--color-leaf))] bg-[length:0_3px] bg-[position:0_100%] bg-no-repeat transition-[background-size] duration-300 group-hover:bg-[length:100%_3px] after:absolute after:inset-0 focus-visible:outline-none group-has-[:focus-visible]:bg-[length:100%_3px]">{card.title}</Link></h3>
    {list ? <p className="mt-2 line-clamp-2 text-[0.9375rem] text-ink-soft">{card.lead}</p> : null}
    <ul className="mt-2.5 flex flex-wrap gap-x-3.5 gap-y-1 text-sm font-bold text-ink-soft"><li className="flex items-center gap-1.5"><HandIcon name="clock" className="size-[22px]" />{card.durationLabel}</li>{card.language ? <li className="flex items-center gap-1.5"><HandIcon name="chat" className="size-[22px]" /><span aria-hidden>{card.language.short}</span><span className="sr-only">{card.language.full}</span></li> : null}{card.reviewLine ? <li><span aria-hidden>{card.reviewLine.text}</span><span className="sr-only">{card.reviewLine.label}</span></li> : null}</ul>
    {highlight ? <p className="mt-3 inline-flex h-7 items-center gap-1.5 self-start rounded-full bg-leaf-pale pr-3 pl-2 text-sm font-extrabold text-moss"><HandIcon name="cal" className="size-5" />{highlight}</p> : dates ?? (card.scheduleLabel ? <p className="mt-3 h-7 text-sm font-bold text-muted">{card.scheduleLabel}</p> : null)}
    <p className="mt-auto pt-3 text-[0.9375rem] text-ink-soft"><RichMessageV1 segments={copy.rich(card.priceIsFrom ? "card.fromPriceRich" : "card.priceRich", { price: card.priceLabel })} emphasisClassName="text-[1.1875rem] font-extrabold text-ink" /></p>
  </div></article>;
}

export function InviteCardV1({ primitives, copy = EN_STATIC_COPY_V1 }: { primitives?: Partial<PresentationPrimitivesV1>; copy?: StaticCopyAccessorV1 }) {
  const { Link } = primitivesV1(primitives);
  return <article className="flex aspect-[4/5] flex-col justify-center gap-3 rounded-[var(--radius-card)] border-[1.5px] border-dashed border-line-strong bg-sand p-7"><HandIcon name="house" className="size-14" /><p className="hand text-[2.125rem]">{copy.text("card.hostTitle")}</p><p className="text-[0.9375rem] text-ink-soft">{copy.text("card.hostBody")}</p><Link href="/host" className="link-leaf self-start">{copy.text("card.hostCta")}</Link></article>;
}

export function FigureV1({ value, unit, note }: { value: string; unit: string; note: string }) {
  return <li><p><b className="block font-display text-[3.875rem] leading-none font-light tracking-[-0.03em] lg:text-[5.5rem]">{value}</b><span className="hand mt-0.5 block text-[1.875rem]">{unit}</span></p><p className="mx-auto mt-2 max-w-[15rem] text-sm leading-[1.6] text-muted">{note}</p></li>;
}

export { HandIcon, RubberStamp };
export type { HandIconName };
