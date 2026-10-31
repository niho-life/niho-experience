import "server-only";
import { readConnectedPayouts, type ConnectedPayout, type ConnectedPayoutsRead } from "@niho-experience/experience-payments";
import { StoreAccessDeniedError } from "@niho-experience/experience-store";
import { config } from "@/lib/config";
import { hostSalesRepository } from "@/lib/experience/store-server";
import type { HostProvider } from "@/lib/host/providers";
import { isHostMock } from "@/lib/host/server";
import type { HostSession } from "@/lib/host/session";
import { todayInJapan } from "./format";
import { MOCK_TODAY } from "./mock/bookings";
import { MOCK_SITE_PAYOUTS } from "./mock/site-sales";
import { addMonths, monthKey, type SalesMonth } from "./sales";
import { ownerActor } from "./site-bookings-server";
import { japanMonthWindow, requestedSiteSalesMonth } from "./site-sales";
import {
  SITE_PAYOUTS_FAILED_TEXT,
  SITE_PAYOUTS_SLOW_TEXT,
  SITE_PAYOUTS_UNREACHABLE_TEXT,
  sitePayoutsPanel,
  type SitePayoutsPanel,
  type SitePayoutsRead,
} from "./site-sales-payouts";

/*
 * この口座への入金 on 売上 (#91): the balance and payouts of the Stripe accounts the OWNER's sales here go to, read from
 * Stripe with the platform key (GETs only). The experience DB names the accounts after its own OWNER check, as the
 * ledger does; the IDs stay on the server (never in the page, its payload or a log). Behind HOST_SALES_PAYOUTS_ENABLED
 * (http mode, under HOST_SALES_LEDGER_ENABLED): off, without the key, the DB or an account, or for anyone else, the
 * section is not there. The preview's `?mock=site-sales` sign-in shows synthetic payouts instead. Stripe failing or
 * answering slowly shows a message in the section only: this site's ledger above it is read apart and stays.
 */

export type HostSitePayoutsLoad = { status: "live"; panel: SitePayoutsPanel } | { status: "closed" } | { status: "error"; text: string };

/** The whole read waits at most this long (each Stripe request has its own shorter limit and one retry). */
export const SITE_PAYOUTS_DEADLINE_MS = 8_000;
const REQUEST_TIMEOUT_MS = 3_500;

/** Payouts arriving in [from, before) (Unix seconds; before null: no end). */
interface PayoutsWindow {
  from: number;
  before: number | null;
}

interface PayoutsReader {
  /** YYYY-MM-DD in Japan: the preview's fixed day in mock mode. */
  today: string;
  read: (window: PayoutsWindow) => Promise<SitePayoutsRead | "unreachable">;
}

class SlowStripeError extends Error {
  constructor() {
    super("Stripe did not answer in time.");
    this.name = "SlowStripeError";
  }
}

function previewRead({ from, before }: PayoutsWindow): SitePayoutsRead {
  const at = (utc: string) => Date.parse(utc) / 1000;
  return { ...MOCK_SITE_PAYOUTS, payouts: MOCK_SITE_PAYOUTS.payouts.filter((payout) => at(payout.arrivalDateUtc) >= from && (before === null || at(payout.arrivalDateUtc) < before)) };
}

/** The accounts' reads as one: summed balance, every payout (the latest arrival first), unreachable if any is. */
function together(reads: readonly ConnectedPayoutsRead[]): SitePayoutsRead | "unreachable" {
  const read: SitePayoutsRead = { accounts: reads.length, balance: [], payouts: [], more: false };
  const balance = new Map<string, { available: number; pending: number }>();
  const payouts: ConnectedPayout[] = [];
  for (const one of reads) {
    if (one.kind === "unreachable") return "unreachable";
    for (const amount of one.balance) {
      const sum = balance.get(amount.currency) ?? { available: 0, pending: 0 };
      balance.set(amount.currency, { available: sum.available + amount.available, pending: sum.pending + amount.pending });
    }
    payouts.push(...one.payouts);
    read.more ||= one.more;
  }
  return {
    ...read,
    balance: [...balance].map(([currency, sum]) => ({ currency, ...sum })),
    payouts: payouts.sort((a, b) => b.arrivalDateUtc.localeCompare(a.arrivalDateUtc)),
  };
}

/** Where this account's payouts are read from; null leaves the section out. */
async function readerFor(provider: Pick<HostProvider, "id" | "memberRole">, session: Pick<HostSession, "nihoUserId" | "mockScenario">): Promise<PayoutsReader | null> {
  if (provider.memberRole !== "OWNER") return null;
  if (isHostMock()) return session.mockScenario === "site-sales" ? { today: MOCK_TODAY, read: async (window) => previewRead(window) } : null;
  const platformStripeKey = process.env.EXPERIENCE_STRIPE_PLATFORM_SECRET_KEY;
  const sales = hostSalesRepository();
  if (!config.hostSalesPayoutsEnabled || !platformStripeKey || !sales) return null;
  const accounts = await sales.listPayoutAccountsForHost(ownerActor(provider.id, session.nihoUserId));
  if (!accounts.length) return null;
  return {
    today: todayInJapan(Date.now()),
    read: async ({ from, before }) => together(await Promise.all(accounts.map((accountId) => readConnectedPayouts({ accountId, arrivalFrom: from, arrivalBefore: before, platformStripeKey, timeoutMs: REQUEST_TIMEOUT_MS })))),
  };
}

async function withinDeadline<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new SlowStripeError()), SITE_PAYOUTS_DEADLINE_MS);
  });
  try {
    return await Promise.race([work, late]);
  } finally {
    clearTimeout(timer);
  }
}

/** Stripe's error class (StripeConnectionError, …) or the error's name: never its message or raw answer. */
function errorName(error: unknown): string {
  const type = (error as { type?: unknown } | null)?.type;
  if (typeof type === "string" && /^Stripe[A-Za-z]*Error$/.test(type)) return type;
  return error instanceof Error ? error.name : typeof error;
}

/**
 * この口座への入金 for `month` (the month 売上 shows): the payouts arriving in it, and for this month the balance and
 * every payout still on its way. This month's read has no end (those due later) and starts at the previous month's
 * first day: a payout due last month that Stripe has not marked paid yet (due 10/31, still in transit on 11/1) has left
 * the balance already, so 入金予定 would miss it otherwise. Stripe settles a payout on or soon after its arrival day, so
 * a month back is ample, and the read stays one page (100) of about two months of payouts. The store's OWNER check
 * failing leaves the section out, as 売上 does.
 */
export async function loadSitePayouts(provider: Pick<HostProvider, "id" | "memberRole">, session: Pick<HostSession, "nihoUserId" | "mockScenario">, month: SalesMonth): Promise<HostSitePayoutsLoad> {
  try {
    const reader = await readerFor(provider, session);
    if (!reader) return { status: "closed" };
    const current = monthKey(month) === monthKey(requestedSiteSalesMonth(null, reader.today));
    const { from } = japanMonthWindow(current ? addMonths(month, -1) : month);
    const { to } = japanMonthWindow(month);
    const read = await withinDeadline(reader.read({ from: Date.parse(from) / 1000, before: current ? null : Date.parse(to) / 1000 }));
    if (read === "unreachable") {
      console.error("Experience host payouts read failed", { error: "unreachable" });
      return { status: "error", text: SITE_PAYOUTS_UNREACHABLE_TEXT };
    }
    return { status: "live", panel: sitePayoutsPanel(read, month, current) };
  } catch (error) {
    if (error instanceof StoreAccessDeniedError) return { status: "closed" };
    console.error("Experience host payouts read failed", { error: errorName(error) });
    return { status: "error", text: error instanceof SlowStripeError ? SITE_PAYOUTS_SLOW_TEXT : SITE_PAYOUTS_FAILED_TEXT };
  }
}
