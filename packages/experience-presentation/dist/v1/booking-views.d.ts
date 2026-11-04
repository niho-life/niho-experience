import type { Ref } from "react";
import { type BookingSummaryModelV1 } from "./components.js";
import { type StaticCopyAccessorV1 } from "./static-copy.js";
import type { PresentationPrimitivesV1 } from "./types.js";
export type BookingSelectionViewModelV1 = Readonly<{
    summary: BookingSummaryModelV1;
    unavailableMessage?: string;
    offerDescription?: string;
    offers: readonly {
        id: string;
        name: string;
        description?: string;
        adultPrice: string;
        selected: boolean;
    }[];
    dates: Readonly<{
        state: "loading" | "error" | "empty" | "ready";
        provisional: boolean;
        options: readonly {
            id: string;
            weekday: string;
            day: string;
            time: string;
            availability?: string;
            bookable: boolean;
            selected: boolean;
        }[];
        moreCount: number;
    }>;
    counters?: readonly {
        id: string;
        label: string;
        note: string;
        value: number;
        maximum: number;
        full: boolean;
    }[];
    guestRange?: {
        minimum: number;
        maximum: number;
        childrenPrice?: string;
    };
    hint?: string;
    total: string;
    totalIsAmount: boolean;
    line: string;
    canContinue: boolean;
}>;
export type BookingSelectionCallbacksV1 = Readonly<{
    onOfferChange?: (id: string) => void;
    onDateChange?: (id: string) => void;
    onCounterChange?: (id: string, value: number) => void;
    onRetry?: () => void;
    onShowMore?: () => void;
    onContinue?: () => void;
}>;
export declare function BookingSelectionViewV1({ model, callbacks, titleAs, primitives, copy }: {
    model: BookingSelectionViewModelV1;
    callbacks?: BookingSelectionCallbacksV1;
    titleAs?: "h1" | "p";
    primitives?: Partial<PresentationPrimitivesV1>;
    copy?: StaticCopyAccessorV1;
}): import("react").JSX.Element;
export type BookingQuestionV1 = Readonly<{
    id: string;
    prompt: string;
    description?: string;
    required: boolean;
    type: "SHORT_TEXT" | "LONG_TEXT" | "SINGLE_SELECT" | "MULTI_SELECT";
    value: string | readonly string[];
    options: readonly {
        id: string;
        label: string;
    }[];
    invalid?: boolean;
}>;
export type BookingCheckoutViewModelV1 = Readonly<{
    summary: BookingSummaryModelV1;
    availability: "checking" | "ready" | "stale" | "unavailable";
    refreshing: boolean;
    refreshDisabled: boolean;
    problem?: string;
    guestName: string;
    invalidGuestName: boolean;
    guestEmail: string;
    invalidGuestEmail: boolean;
    note: string;
    invalidNote: boolean;
    questions: readonly BookingQuestionV1[];
    approval: boolean;
    actionLabel?: string;
    reviewHeading?: string;
    totalNote?: string;
    confirmationNote?: string;
    sellerNote?: string;
    paymentDisclosure?: string;
    review: readonly {
        label: string;
        value: string;
    }[];
    total: string;
    policyTitle: string;
    sellerName: string;
    sellerLegalUrl?: string;
    legalDocuments: readonly {
        kind: "COMMERCIAL_TRANSACTIONS" | "PRIVACY" | "TERMS";
        url: string;
    }[];
    consentVersion: string;
    agreed: boolean;
    invalidConsent: boolean;
    preview: boolean;
    submitting: boolean;
    retryWaiting: boolean;
    actionDisabled: boolean;
    when: string;
    /**
     * Optional additions for the guest journey (Epic #103). When absent the screen is exactly as before.
     * The consumer supplies these display strings (they are not in the static copy registry, so saved localization snapshots stay complete).
     */
    /** "Before you book": participation conditions the whole group must accept. Adds one step before "Your details". */
    conditions?: Readonly<{
        heading: string;
        agreeIntro: string;
        items: readonly string[];
        agreed: boolean;
        invalid: boolean;
    }>;
    /** Optional mobile number for the day of the experience. */
    guestPhone?: Readonly<{
        label: string;
        hint?: string;
        value: string;
        invalid: boolean;
    }>;
    /** Replaces "Questions from your host", e.g. "Questions from Shiryu". */
    hostQuestionsHeading?: string;
}>;
export type BookingCheckoutCallbacksV1 = Readonly<{
    onBack?: () => void;
    onRefresh?: () => void;
    onGuestNameChange?: (value: string) => void;
    onGuestEmailChange?: (value: string) => void;
    onGuestPhoneChange?: (value: string) => void;
    onNoteChange?: (value: string) => void;
    onAnswerChange?: (id: string, value: string | string[]) => void;
    onAgreementChange?: (value: boolean) => void;
    onConditionsAgreementChange?: (value: boolean) => void;
    onSubmit?: () => void;
}>;
export declare function BookingCheckoutViewV1({ model, callbacks, titleAs, problemRef, primitives, copy }: {
    model: BookingCheckoutViewModelV1;
    callbacks?: BookingCheckoutCallbacksV1;
    titleAs?: "h1" | "p";
    problemRef?: Ref<HTMLDivElement>;
    primitives?: Partial<PresentationPrimitivesV1>;
    copy?: StaticCopyAccessorV1;
}): import("react").JSX.Element;
