/** The host's support choice copied onto a booking when the request is accepted. */
export interface BookingSupportSnapshot {
  enabled: boolean;
  /** NIHO platform fee including support, fixed for this booking. */
  feePercent: 10 | 15;
  /** The host allowed NIHO staff to share and operate supported bookings. */
  operationsAllowed: boolean;
  /** Staff time is paid directly by the host to the person who helps. */
  staffingPayment: "direct";
  /** YYYY-MM-DDTHH:MM in Japan. */
  acceptedAt: string;
}

export interface BookingSupportHistory {
  at: string;
  actor: string;
  text: string;
}

/** What a host may see about NIHO's support work on one of its own bookings. */
export interface HostBookingSupportView {
  snapshot: BookingSupportSnapshot;
  consultation: string;
  assignee: string | null;
  history: readonly BookingSupportHistory[];
}

export const SUPPORT_FEE_PERCENT = { off: 10, on: 15 } as const;

export function supportSnapshot(enabled: boolean, acceptedAt: string): BookingSupportSnapshot {
  return {
    enabled,
    feePercent: enabled ? SUPPORT_FEE_PERCENT.on : SUPPORT_FEE_PERCENT.off,
    operationsAllowed: enabled,
    staffingPayment: "direct",
    acceptedAt,
  };
}

