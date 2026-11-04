import type {
  ExperienceDetail,
  ExperienceDetailV11,
  PublicImage,
  PublicImageV11,
  ExperienceSummary,
  ExperienceSummaryV11,
  ExperienceSummaryV12,
  ExperienceOffer,
} from "@niho-experience/api-client";

export type ExperienceOfferForSite = ExperienceOffer & {
  /** Experience's optional adult-price floor; NIHO offers default to one. */
  readonly minimumChargeableParticipants?: number;
  /** Exact Experience cancellation snapshot, including custom windows and partial refunds. */
  readonly saleCancellation?: {
    readonly policyCode: "FREE_UNTIL_24H" | "FREE_UNTIL_48H" | "NONE" | "CUSTOM";
    readonly cancellationWindowMinutesBeforeStart: number | null;
    readonly refundBasisPoints: number;
  };
};

type WithSiteOffers<T> = T extends unknown ? Omit<T, "offers"> & { offers: ExperienceOfferForSite[] } : never;
export type ExperienceDetailForSite = WithSiteOffers<ExperienceDetail | ExperienceDetailV11>;
export type ExperienceSummaryForSite = ExperienceSummary | ExperienceSummaryV11 | ExperienceSummaryV12;
export type PublicImageForSite = PublicImage | PublicImageV11;
