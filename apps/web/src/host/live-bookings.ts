import type {
  ExperienceProviderBookingDetailResponse,
  ExperienceProviderBookingListResponse,
  ExperienceProviderMessageResponse,
} from "@niho-experience/api-client/experience-provider-operations";

type UpstreamListItem = ExperienceProviderBookingListResponse["bookings"][number];
type UpstreamDetail = ExperienceProviderBookingDetailResponse["booking"];

/** Browser DTO for the provider booking list. The upstream email and provider internals never cross the BFF. */
export interface HostLiveBookingListItem {
  id: string;
  /** NIHO's page and offer: 予約's one list (#84) puts the booking under its session. */
  pageId: string;
  offerId: string;
  occurrenceDate: string;
  startAt: string;
  endAt: string;
  headCount: number;
  offerName: string;
  totalYen: number;
  guestName: string;
  pageTitle: string;
  status: UpstreamListItem["status"];
  salesChannel: UpstreamListItem["salesChannel"];
}

export interface HostLiveBookingListResponse {
  bookings: HostLiveBookingListItem[];
  nextCursor: string | null;
}

/** Browser DTO for one booking. It deliberately has no guest email or sender/reply-to fields. */
export interface HostLiveBookingDetailResponse {
  booking: {
    id: string;
    pageId: string;
    pageTitle: string;
    offerName: string;
    occurrenceDate: string;
    startAt: string;
    endAt: string;
    adultCount: number;
    childCount: number;
    guestName: string;
    languageSnapshot: string;
    note: string | null;
    answers: UpstreamDetail["answers"];
    status: UpstreamDetail["status"];
    totalYen: number;
    salesChannel: string;
    hostMessages: UpstreamDetail["hostMessages"];
    guestMessages: UpstreamDetail["guestMessages"];
  };
}

export interface HostLiveMessageReceiptResponse {
  message: Pick<ExperienceProviderMessageResponse["message"], "id">;
}

export interface HostLiveBookingStatusResponse {
  status: UpstreamDetail["status"];
}

export function projectHostBookingList(value: ExperienceProviderBookingListResponse): HostLiveBookingListResponse {
  return {
    bookings: value.bookings.map((booking) => ({
      id: booking.id,
      pageId: booking.pageId,
      offerId: booking.offerId,
      occurrenceDate: booking.occurrenceDate,
      startAt: booking.startAt,
      endAt: booking.endAt,
      headCount: booking.headCount,
      offerName: booking.offerNameSnapshot,
      totalYen: booking.totalYenSnapshot,
      guestName: booking.guestName,
      pageTitle: booking.page.title,
      status: booking.status,
      salesChannel: booking.salesChannel,
    })),
    nextCursor: value.nextCursor,
  };
}

export function projectHostBookingDetail(value: ExperienceProviderBookingDetailResponse): HostLiveBookingDetailResponse {
  const booking = value.booking;
  return {
    booking: {
      id: booking.id,
      pageId: booking.pageId,
      pageTitle: booking.page.title,
      offerName: booking.offerName,
      occurrenceDate: booking.occurrenceDate,
      startAt: booking.startAt,
      endAt: booking.endAt,
      adultCount: booking.adultCount,
      childCount: booking.childCount,
      guestName: booking.guestName,
      languageSnapshot: booking.languageSnapshot,
      note: booking.note,
      answers: booking.answers,
      status: booking.status,
      totalYen: booking.totalYen,
      salesChannel: booking.salesChannel,
      hostMessages: booking.hostMessages,
      guestMessages: booking.guestMessages,
    },
  };
}

export function projectHostMessageReceipt(value: ExperienceProviderMessageResponse): HostLiveMessageReceiptResponse {
  return { message: { id: value.message.id } };
}
