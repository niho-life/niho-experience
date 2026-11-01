"use server";

import { nihoIdOrNull } from "@/lib/host/providers";
import { issueCalendarFeedAsOwner, revokeCalendarFeedAsOwner } from "./calendar-server";
import { HOST_INVALID_INPUT_TEXT } from "./errors";
import type { HostActionResult } from "./payout";

/*
 * 設定 › カレンダー's bookings feed (#109) as server actions: URL を作る / 作り直す and URL を止める. The provider id comes
 * from the browser, so it is checked here; calendar-server.ts checks the flag, the session, NIHO's OWNER role and the
 * store's. The answer carries the new address (null once stopped), which the panel shows in place of the old one.
 */

type FeedResult = HostActionResult<{ url: string | null }>;

const invalid = { ok: false, message: HOST_INVALID_INPUT_TEXT } as const;

export async function issueHostCalendarFeed(providerId: string): Promise<FeedResult> {
  const id = nihoIdOrNull(providerId);
  return id ? issueCalendarFeedAsOwner(id) : invalid;
}

export async function revokeHostCalendarFeed(providerId: string): Promise<FeedResult> {
  const id = nihoIdOrNull(providerId);
  return id ? revokeCalendarFeedAsOwner(id) : invalid;
}
