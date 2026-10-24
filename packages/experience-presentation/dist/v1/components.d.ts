import type { ReactNode } from "react";
import { HandIcon, RubberStamp, type HandIconName } from "./icons.js";
import { type RichTextSegmentV1, type StaticCopyAccessorV1 } from "./static-copy.js";
import { type DisplayImageV1, type DisplayVideoV1, type FaceV1, type PresentationPrimitivesV1 } from "./types.js";
export declare const PRESENTATION_SCOPE_CLASS_V1 = "nexp-v1";
export declare function RichMessageV1({ segments, emphasisClassName }: {
    segments: readonly RichTextSegmentV1[];
    emphasisClassName?: string;
}): import("react").JSX.Element;
export declare function PresentationRootV1({ children, className }: {
    children: ReactNode;
    className?: string;
}): import("react").JSX.Element;
export type ButtonVariantV1 = "primary" | "secondary" | "ghost";
export declare const buttonClassV1: (variant?: ButtonVariantV1, extra?: string) => string;
export declare function ButtonLinkV1({ href, children, variant, className, primitives }: {
    href: string;
    children: ReactNode;
    variant?: ButtonVariantV1;
    className?: string;
    primitives?: Partial<PresentationPrimitivesV1>;
}): import("react").JSX.Element;
export declare function SectionHeadingV1({ eyebrow, title, id, children, align, action }: {
    eyebrow?: string;
    title: ReactNode;
    id?: string;
    children?: ReactNode;
    align?: "start" | "center";
    action?: ReactNode;
}): import("react").JSX.Element;
export declare function PhotoV1({ image, alt, sizes, priority, primitives, className, rounded, aspect, imgClassName, emptyLabel }: {
    image: DisplayImageV1 | null;
    alt: string;
    sizes: string;
    priority?: boolean;
    primitives?: Partial<PresentationPrimitivesV1>;
    className?: string;
    rounded?: string;
    aspect?: string;
    imgClassName?: string;
    emptyLabel?: string;
}): import("react").JSX.Element;
export declare function FaceBadgeV1({ face, primitives, className, sizes }: {
    face: FaceV1;
    primitives?: Partial<PresentationPrimitivesV1>;
    className?: string;
    sizes?: string;
}): import("react").JSX.Element;
export declare function DecorativeVideoV1({ video, primitives, className }: {
    video: DisplayVideoV1;
    primitives?: Partial<PresentationPrimitivesV1>;
    className?: string;
}): import("react").JSX.Element;
export declare function NoticeV1({ tone, title, children, action, role, copy }: {
    tone?: "info" | "warn" | "danger" | "success" | "neutral";
    title: string;
    children?: ReactNode;
    action?: ReactNode;
    role?: "status" | "alert";
    copy?: StaticCopyAccessorV1;
}): import("react").JSX.Element;
export type BookingSummaryModelV1 = Readonly<{
    title: string;
    image: DisplayImageV1 | null;
    summary?: string;
}>;
/** `aside`: inside a booking view's @container, from @4xl (56rem) the card turns into the right column's vertical summary (photo on top). */
export declare function BookingSummaryV1({ model, titleAs, primitives, aside, className }: {
    model: BookingSummaryModelV1;
    titleAs?: "h1" | "p";
    primitives?: Partial<PresentationPrimitivesV1>;
    aside?: boolean;
    className?: string;
}): import("react").JSX.Element;
export declare function BookingStepHeadingV1({ id, step, label, children }: {
    id?: string;
    step: number;
    label: string;
    children: ReactNode;
}): import("react").JSX.Element;
/** `aside`: inside a booking view's @container, from @4xl the bottom bar becomes an in-flow card that sticks below the header (total and date on top, action below). */
export declare function BookingBarV1({ total, line, action, stack, aside, className }: {
    total: ReactNode;
    line: ReactNode;
    action: ReactNode;
    stack?: boolean;
    aside?: boolean;
    className?: string;
}): import("react").JSX.Element;
export declare const BOOKING_FIELD_LABEL_CLASS_V1 = "mt-3.5 block text-[0.90625rem] font-extrabold";
export declare const BOOKING_FIELD_INPUT_CLASS_V1 = "mt-1.5 block min-h-[50px] w-full rounded-[14px] border border-line-strong bg-white px-3.5 py-3 text-base leading-snug font-normal text-ink focus-visible:border-transparent focus-visible:outline-offset-1 aria-[invalid=true]:border-danger";
export type ExperienceCardModelV1 = Readonly<{
    slug: string;
    href: string;
    cover: DisplayImageV1 | null;
    face: FaceV1;
    groupLabel: string | null;
    withLabel: string;
    title: string;
    lead: string;
    durationLabel: string;
    language: {
        short: string;
        full: string;
    } | null;
    scheduleLabel: string | null;
    priceLabel: string;
    priceIsFrom: boolean;
    priceSuffix: string;
    /** "★ 4.9 · 12" and its spoken form. Only for experiences that have reviews (the average only from three). */
    reviewLine?: Readonly<{
        text: string;
        label: string;
    }>;
}>;
export declare function ExperienceCardV1({ card, dates, highlight, variant, priority, primitives, copy }: {
    card: ExperienceCardModelV1;
    dates?: ReactNode;
    highlight?: string | null;
    variant?: "home" | "list";
    priority?: boolean;
    primitives?: Partial<PresentationPrimitivesV1>;
    copy?: StaticCopyAccessorV1;
}): import("react").JSX.Element;
export declare function InviteCardV1({ primitives, copy }: {
    primitives?: Partial<PresentationPrimitivesV1>;
    copy?: StaticCopyAccessorV1;
}): import("react").JSX.Element;
export declare function FigureV1({ value, unit, note }: {
    value: string;
    unit: string;
    note: string;
}): import("react").JSX.Element;
export { HandIcon, RubberStamp };
export type { HandIconName };
