import type { ReactNode } from "react";
import { type RichTextSegmentV1, type StaticCopyAccessorV1 } from "./static-copy.js";
import { type ExperienceCardModelV1, type HandIconName } from "./components.js";
import { type BookingCheckoutViewModelV1, type BookingSelectionViewModelV1 } from "./booking-views.js";
import { type DetailBookingCardModelV1 } from "./detail-booking.js";
import { type DetailGalleryModelV1, type DisplayImageV1, type DisplayVideoV1, type FaceV1, type PresentationPrimitivesV1 } from "./types.js";
export type HomeViewModelV1 = Readonly<{
    hero: DisplayImageV1;
    finder: ReactNode;
    themes: readonly {
        key: string;
        href: string;
        icon: HandIconName;
        label: string;
    }[];
    cardsEyebrow?: string;
    cards: readonly {
        model: ExperienceCardModelV1;
        dates?: ReactNode;
    }[];
    empty?: ReactNode;
    feature?: {
        schedule?: string;
        heading: string;
        body: string;
        cta: string;
        href: string;
        photos: readonly DisplayImageV1[];
    };
    strips: readonly {
        key: string;
        href: string;
        verb: string;
        name: string;
        video: DisplayVideoV1;
    }[];
    stripsEyebrow: string;
    banner: DisplayVideoV1;
    hostFeature?: {
        headingEyebrow: string;
        headingTitle: string;
        moreHostsLabel: string;
        name: string;
        role?: string;
        story: string;
        cta: string;
        href: string;
        image?: DisplayImageV1;
        video?: DisplayVideoV1;
        faces: readonly {
            face: FaceV1;
            href: string;
            label: string;
            current: boolean;
        }[];
    };
    figures: readonly {
        value: string;
        unit: string;
        note: string;
    }[];
    postcards: readonly {
        id: string;
        image: DisplayImageV1;
        place: string;
        rotate: number;
    }[];
    hostBand: DisplayVideoV1;
}>;
export declare function HomeViewV1({ model, primitives, copy }: {
    model: HomeViewModelV1;
    primitives?: Partial<PresentationPrimitivesV1>;
    copy?: StaticCopyAccessorV1;
}): import("react").JSX.Element;
export declare function SiteHeaderV1({ primitives, copy, currentPath, labels, experiencesLink }: {
    primitives?: Partial<PresentationPrimitivesV1>;
    copy?: StaticCopyAccessorV1;
    currentPath?: string;
    labels?: {
        brand?: string;
        experiences?: string;
        host?: string;
        help?: string;
    };
    experiencesLink?: ReactNode;
}): import("react").JSX.Element;
export declare function SiteFooterV1({ primitives, copy, previewNote, description, copyright }: {
    primitives?: Partial<PresentationPrimitivesV1>;
    copy?: StaticCopyAccessorV1;
    previewNote?: ReactNode;
    description?: string;
    copyright?: string;
}): import("react").JSX.Element;
export declare function SiteFrameV1({ children, header, footer, copy }: {
    children: ReactNode;
    header: ReactNode;
    footer: ReactNode;
    copy?: StaticCopyAccessorV1;
}): import("react").JSX.Element;
export declare function CatalogueViewV1({ heading, content, copy }: {
    heading?: string;
    content: ReactNode;
    copy?: StaticCopyAccessorV1;
}): import("react").JSX.Element;
export type HelpViewModelV1 = Readonly<{
    primaryHref: string;
    primaryLabelKey: "help.niho" | "help.email";
    emailHref: string;
    emailLabel: string;
}>;
export declare function HelpViewV1({ model, copy }: {
    model: HelpViewModelV1;
    copy?: StaticCopyAccessorV1;
}): import("react").JSX.Element;
export type HostViewModelV1 = Readonly<{
    video: DisplayVideoV1;
    steps: readonly {
        title: string;
        body: string;
    }[];
    you: readonly string[];
    niho: readonly string[];
    signup: ReactNode;
    signupOpen: boolean;
}>;
export declare function HostViewV1({ model, primitives, copy }: {
    model: HostViewModelV1;
    primitives?: Partial<PresentationPrimitivesV1>;
    copy?: StaticCopyAccessorV1;
}): import("react").JSX.Element;
/** `wide`: from lg the page uses the normal page width so the booking views can show their two-column desktop layout. */
export declare function BookingPageViewV1({ backHref, backLabel, backAccessibleLabel, panel, primitives, copy, wide }: {
    backHref: string;
    backLabel: string;
    backAccessibleLabel?: string;
    panel: ReactNode;
    primitives?: Partial<PresentationPrimitivesV1>;
    copy?: StaticCopyAccessorV1;
    wide?: boolean;
}): import("react").JSX.Element;
export type BookingPreviewModelV1 = Readonly<{
    selection: BookingSelectionViewModelV1;
    checkout: BookingCheckoutViewModelV1;
}>;
export declare function BookingPreviewV1({ model, primitives, copy }: {
    model: BookingPreviewModelV1;
    primitives?: Partial<PresentationPrimitivesV1>;
    copy?: StaticCopyAccessorV1;
}): import("react").JSX.Element;
export type DetailMeetingModelV1 = Readonly<({
    kind: "location";
    name: string;
    address?: string;
    accessNote?: string;
    entranceNote?: string;
    mapUrl?: string;
    exterior?: DisplayImageV1 | null;
} | {
    kind: "after-booking";
}) & {
    overview?: string;
}>;
export type DetailCancellationModelV1 = Readonly<{
    policy?: {
        title: string;
        acceptanceNote: string;
    };
    sellerName: string;
    sellerLegalUrl?: string;
}>;
/** The one line under the title: "★ 4.9 · 12 reviews" (a link to the reviews), "2 reviews", or the "New" badge. The consumer supplies the strings. */
export type DetailReviewHeadlineV1 = Readonly<{
    label: string;
    accessibleLabel?: string;
    href?: string;
    isNew?: boolean;
}>;
/** The reviews section (anchor `#reviews`): a heading and the consumer's content. Placed before the cancellation terms. */
export type DetailReviewsV1 = Readonly<{
    title: string;
    content: ReactNode;
}>;
/** One structured participation condition ("Ages 10 and up" + a smaller line). The consumer supplies the display strings. */
export type DetailConditionV1 = Readonly<{
    icon: HandIconName;
    headline: string;
    detail?: string;
}>;
export type DetailViewModelV1 = Readonly<{
    title: string;
    backHref: string;
    gallery: DetailGalleryModelV1;
    schedule?: string;
    hosts: readonly FaceV1[];
    hostLine: readonly RichTextSegmentV1[];
    facts: readonly {
        icon: HandIconName;
        label: string;
        main: string;
        sub?: string | null;
    }[];
    lead: string;
    highlights: readonly {
        text: string;
        icon: HandIconName;
    }[];
    paragraphs: readonly string[];
    timeline: readonly {
        time?: string;
        title: string;
        text: string;
        icon: HandIconName;
        photo?: DisplayImageV1 | null;
    }[];
    provider: {
        name: string;
        tagline?: string;
        photo?: DisplayImageV1 | null;
        hosts: readonly FaceV1[];
    };
    included: readonly string[];
    notIncluded: readonly string[];
    emptyListLabel: string;
    meeting: DetailMeetingModelV1;
    know: readonly string[];
    showAllKnowLabel: string;
    notSuitable: readonly string[];
    cancellation: DetailCancellationModelV1;
    booking?: DetailBookingCardModelV1;
    checkoutCancelled?: ReactNode;
    conditions?: readonly DetailConditionV1[];
    askHost?: ReactNode;
    reviewHeadline?: DetailReviewHeadlineV1;
    reviews?: DetailReviewsV1;
}>;
export declare function DetailViewV1({ model, primitives, copy, headings }: {
    model: DetailViewModelV1;
    primitives?: Partial<PresentationPrimitivesV1>;
    copy?: StaticCopyAccessorV1;
    headings?: {
        overview?: string;
        details?: string;
    };
}): import("react").JSX.Element;
