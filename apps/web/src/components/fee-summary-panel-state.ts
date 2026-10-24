import { decodeExperienceFeeSummaryResponse, type ExperienceFeeSummary } from "@niho-experience/api-client/fee-summary";

export type FeeSummaryAudience = "admin" | "host";
export type FeeSummaryLoadState = "disabled" | "loading" | "ready" | "not-found" | "network-error" | "error" | "expired";
export type FeeSummaryView = {
  target: string;
  value: FeeSummaryLoadState;
  summary: ExperienceFeeSummary | null;
};

export type FeeSummaryRequestResult =
  | { value: Exclude<FeeSummaryLoadState, "disabled" | "loading" | "ready"> }
  | { value: "ready"; summary: ExperienceFeeSummary };

export function feeSummaryTarget(audience: FeeSummaryAudience, actorKey: string, bookingId: string) {
  return JSON.stringify([audience, actorKey, bookingId]);
}

export function feeSummaryPanelInstanceKey(audience: FeeSummaryAudience, actorKey: string, bookingId: string, enabled: boolean) {
  return JSON.stringify([audience, actorKey, bookingId, enabled]);
}

export function initialFeeSummaryView(target: string, enabled: boolean): FeeSummaryView {
  return { target, value: enabled ? "loading" : "disabled", summary: null };
}

export function feeSummaryViewFromResult(target: string, result: FeeSummaryRequestResult): FeeSummaryView {
  return result.value === "ready"
    ? { target, value: "ready", summary: result.summary }
    : { target, value: result.value, summary: null };
}

export async function loadFeeSummaryRequest({
  bookingId,
  request,
  isCurrent,
}: {
  bookingId: string;
  request: () => Promise<Response>;
  isCurrent: () => boolean;
}): Promise<FeeSummaryRequestResult | null> {
  let response: Response;
  try {
    response = await request();
  } catch {
    return isCurrent() ? { value: "network-error" } : null;
  }
  if (!isCurrent()) return null;

  if (response.status === 401 || response.status === 403) return { value: "expired" };
  if (response.status === 404) return { value: "not-found" };

  let value: unknown;
  try {
    value = await response.json() as unknown;
  } catch {
    return isCurrent() ? { value: "error" } : null;
  }
  if (!isCurrent()) return null;

  const decoded = decodeExperienceFeeSummaryResponse(value);
  if (!response.ok || !decoded || decoded.feeSummary.bookingRequestId !== bookingId) return { value: "error" };
  return { value: "ready", summary: decoded.feeSummary };
}
