import { StoreAccessDeniedError } from "@niho-experience/experience-store";
import { config } from "@/lib/config";
import { channelJson, channelManagerEnabled } from "@/lib/experience/channel-runtime";
import { calendarActor } from "@/lib/experience/calendar-actor";
import { channelRuntime } from "@/lib/experience/store-server";

export const runtime = "nodejs";

export async function GET(request: Request) {
  if (!config.hostConsoleEnabled || !channelManagerEnabled()) return channelJson({ error: "not_found" }, 404);
  const url = new URL(request.url);
  if ([...url.searchParams.keys()].some((key) => key !== "providerId")) return channelJson({ error: "invalid_input" }, 400);
  const established = await calendarActor(url.searchParams.get("providerId"));
  if ("response" in established) return established.response;
  const runtime = channelRuntime();
  if (!runtime) return channelJson({ error: "runtime_unavailable" }, 503);
  try {
    const statuses = await runtime.hostStatuses(established.actor);
    return channelJson({ channels: statuses.map(({ occurrenceId, site, desired, observed, label, lastVerifiedAtUtc, error }) => ({
      occurrenceId, site, desired, ...(observed === undefined ? {} : { observed }), label,
      ...(lastVerifiedAtUtc === undefined ? {} : { lastVerifiedAtUtc }), ...(error === undefined ? {} : { error }),
    })) });
  } catch (error) {
    return channelJson({ error: error instanceof StoreAccessDeniedError ? "forbidden" : "runtime_unavailable" }, error instanceof StoreAccessDeniedError ? 403 : 503);
  }
}
