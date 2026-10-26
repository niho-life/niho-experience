import type { ExperienceProviderBookingDetailResponse } from "@niho-experience/api-client/experience-provider-operations";

type HostMessage = ExperienceProviderBookingDetailResponse["booking"]["hostMessages"][number];

export function canDecideLiveBooking(status: string): boolean {
  return status === "PROVISIONAL";
}

export function findUncertainMessage(
  messages: readonly HostMessage[],
  baselineIds: readonly string[],
  receiptId: string | null,
  subject: string | null,
): HostMessage | null {
  const added = messages.filter((item) => !baselineIds.includes(item.id));
  return added.find((item) => receiptId ? item.id === receiptId : item.subject === subject) ?? null;
}
