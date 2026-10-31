import "server-only";
import { StoreAccessDeniedError, type HostSalesWindow, type HostSalesWindowOptions } from "@niho-experience/experience-store";
import { hostSalesRepository } from "@/lib/experience/store-server";
import type { HostProvider } from "@/lib/host/providers";
import { isHostMock } from "@/lib/host/server";
import type { HostSession } from "@/lib/host/session";
import { todayInJapan } from "./format";
import type { HomeMonth } from "./home";
import { MOCK_TODAY } from "./mock/bookings";
import { MOCK_SITE_SALES } from "./mock/site-sales";
import { monthKey, type SalesPage } from "./sales";
import { ownerActor } from "./site-bookings-server";
import { japanMonthWindow, requestedSiteSalesMonth, siteHomeMonth, siteSalesPage, siteSalesPeriod } from "./site-sales";

/*
 * 売上 and ホーム's month for bookings made on this site (#91), from the experience DB's payment ledger. NIHO proves
 * the account and that it is the provider's OWNER (the console's provider list); the store checks its own current
 * OWNER membership as well (ADR 0002), as 予約 does. Behind HOST_SALES_LEDGER_ENABLED (http mode): off, without the DB,
 * or for anyone else, the screens stay as they are (the preview's synthetic ledger, or 準備中). The preview's
 * `?mock=site-sales` sign-in shows this screen from a synthetic ledger instead.
 */

export type HostSiteSalesLoad = { status: "live"; page: SalesPage } | { status: "closed" } | { status: "error" };
export type HostSiteHomeMonthLoad = { status: "live"; month: HomeMonth } | { status: "closed" } | { status: "error" };

interface LedgerReader {
  /** YYYY-MM-DD in Japan: the preview's fixed day in mock mode. */
  today: string;
  read: (window: HostSalesWindowOptions) => Promise<HostSalesWindow>;
}

function previewWindow({ from, to }: HostSalesWindowOptions): HostSalesWindow {
  const at = (utc: string) => Date.parse(utc);
  return {
    entries: MOCK_SITE_SALES.filter((entry) => at(entry.occurredAtUtc) >= at(from) && at(entry.occurredAtUtc) < at(to)),
    firstEntryAtUtc: MOCK_SITE_SALES.at(-1)?.occurredAtUtc ?? null,
  };
}

/** Where this account's sales made here are read from; null keeps today's screen. */
function readerFor(provider: Pick<HostProvider, "id" | "memberRole">, session: Pick<HostSession, "nihoUserId" | "mockScenario">): LedgerReader | null {
  if (provider.memberRole !== "OWNER") return null;
  if (isHostMock()) return session.mockScenario === "site-sales" ? { today: MOCK_TODAY, read: async (window) => previewWindow(window) } : null;
  const sales = hostSalesRepository();
  if (!sales) return null;
  const actor = ownerActor(provider.id, session.nihoUserId);
  return { today: todayInJapan(Date.now()), read: (window) => sales.listGuestSalesForHost(actor, window) };
}

/** The store's OWNER check failing keeps today's screen, as 予約 does; anything else is a failure to read. */
function failed(error: unknown): { status: "closed" } | { status: "error" } {
  if (error instanceof StoreAccessDeniedError) return { status: "closed" };
  console.error("Experience host sales read failed", { error: error instanceof Error ? error.name : typeof error });
  return { status: "error" };
}

/**
 * 売上 for `?month=` (this month in Japan when it names none, a later one, or one before the provider's first entry):
 * the month's entries, its numbers and the months to move between.
 */
export async function loadSiteSales(provider: Pick<HostProvider, "id" | "memberRole">, session: Pick<HostSession, "nihoUserId" | "mockScenario">, requested: unknown): Promise<HostSiteSalesLoad> {
  const reader = readerFor(provider, session);
  if (!reader) return { status: "closed" };
  try {
    let month = requestedSiteSalesMonth(requested, reader.today);
    let read = await reader.read(japanMonthWindow(month));
    const period = siteSalesPeriod(read.firstEntryAtUtc, reader.today);
    if (monthKey(month) < monthKey(period.first)) {
      month = period.current;
      read = await reader.read(japanMonthWindow(month));
    }
    return { status: "live", page: siteSalesPage(read.entries, period, month) };
  } catch (error) {
    return failed(error);
  }
}

/** ホーム's card: this month in Japan. */
export async function loadSiteHomeMonth(provider: Pick<HostProvider, "id" | "memberRole">, session: Pick<HostSession, "nihoUserId" | "mockScenario">): Promise<HostSiteHomeMonthLoad> {
  const reader = readerFor(provider, session);
  if (!reader) return { status: "closed" };
  const month = requestedSiteSalesMonth(null, reader.today);
  try {
    const read = await reader.read(japanMonthWindow(month));
    return { status: "live", month: siteHomeMonth(read.entries, month) };
  } catch (error) {
    return failed(error);
  }
}
