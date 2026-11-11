import type { Metadata } from "next";
import { Suspense, type ReactNode } from "react";
import { HostRegisterPrompt } from "@/components/host/HostRegisterPrompt";
import { SalesLines, SalesLoading, SalesMonthNav, SalesPayoutNoticeView, SalesPayoutsMessage, SalesPayoutsPanel, SalesScope, SalesSummaryPanel } from "@/components/host/HostSales";
import { SettlementSummaryList } from "@/components/settlement/SettlementSummaryList";
import { HOST_SURFACE } from "@/components/host/host-ui";
import { HostPageBody, PageHead } from "@/components/host/ui";
import { hostPageContext, loadHostPayout, loadHostSales } from "@/host/data";
import { notFound } from "next/navigation";
import { salesPayoutNotice } from "@/host/payout";
import { salesPage, type SalesMonth, type SalesPage } from "@/host/sales";
import { SITE_SALES_LOAD_FAILED_TEXT, SITE_SALES_SCOPE_TEXT } from "@/host/site-sales";
import { SITE_PAYOUTS_LOADING_TEXT } from "@/host/site-sales-payouts";
import { loadSitePayouts } from "@/host/site-sales-payouts-server";
import { loadSiteSales } from "@/host/site-sales-server";
import { ownerActor } from "@/host/site-bookings-server";
import { config } from "@/lib/config";
import { experienceSupportRepository, managedExperienceSalesRepository } from "@/lib/experience/store-server";
import type { HostProvider } from "@/lib/host/providers";
import { HOST_SETTINGS_PATH, withProvider } from "@/lib/host/routes";
import type { HostSession } from "@/lib/host/session";

export const metadata: Metadata = { title: "売上" };

type SearchParams = Record<string, string | string[] | undefined>;

interface MonthProps {
  provider: HostProvider;
  /** Who reads: never the session's tokens. */
  reader: Pick<HostSession, "mockScenario">;
  month: SearchParams["month"];
  linkProviderId: string | null;
}

/**
 * 売上 (#91, mock v2): one month of sales, fees, refunds and payouts (`?month=YYYY-MM`) and the
 * note when the payout account is not ready yet (NIHO's readiness, the owner's to read). The
 * ledger is synthetic in mock mode; http mode says 準備中 until NIHO's API has sales.
 *
 * With HOST_SALES_LEDGER_ENABLED (http mode), the OWNER reads the sales of bookings made on this site from the
 * experience DB's ledger instead (#91, ADR 0002): 売上・手数料・返金・受取額 of a month in Japan, said to be this
 * site's only. The month streams in after the OWNER check, so anyone else still gets a 404. With
 * HOST_SALES_PAYOUTS_ENABLED as well, この口座への入金 follows under its own title: Stripe's balance and payouts of the
 * account (which takes NIHO's sales too), streamed apart so a slow or failing Stripe leaves this site's month as it is.
 */
export default async function HostSalesPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const query = await searchParams;
  const context = await hostPageContext(query);
  // The console layout shows sign-in, refresh and error states.
  if (!context) return null;
  const { provider, linkProviderId } = context;
  if (!provider) return <HostRegisterPrompt title="売上" />;
  if (provider.memberRole !== "OWNER") notFound();
  const reader = { mockScenario: context.session.mockScenario };
  return (
    <Suspense key={String(query.month ?? "")} fallback={
        <SalesFrame>
          <SalesLoading />
        </SalesFrame>
      }>
      <HostSalesMonth provider={provider} reader={reader} month={query.month} linkProviderId={linkProviderId} />
    </Suspense>
  );
}

/** The page's title, with the month switch once the month is known. */
function SalesFrame({ page, linkProviderId = null, children }: { page?: SalesPage; linkProviderId?: string | null; children: ReactNode }) {
  return (
    <HostPageBody>
      <PageHead title="売上">{page ? <SalesMonthNav page={page} providerId={linkProviderId} /> : null}</PageHead>
      {children}
    </HostPageBody>
  );
}

/** The month: this site's ledger when it is open to the OWNER, otherwise the preview's ledger or 準備中. */
async function HostSalesMonth({ provider, reader, month, linkProviderId }: MonthProps) {
  const [site, payout] = await Promise.all([loadSiteSales(provider, reader, month), loadHostPayout(provider, { candidates: false })]);
  const notice = salesPayoutNotice(payout.load);
  const noticeView = notice ? <SalesPayoutNoticeView notice={notice} settingsHref={`${withProvider(HOST_SETTINGS_PATH, linkProviderId)}#settings-payout`} /> : null;

  if (site.status === "live") {
    const stripeLoginProviderId = reader.mockScenario ? null : provider.id;
    return (
      <SalesFrame page={site.page} linkProviderId={linkProviderId}>
        <SalesScope text={SITE_SALES_SCOPE_TEXT} />
        {noticeView}
        <SalesSummaryPanel page={site.page} providerId={stripeLoginProviderId} />
        <SalesLines page={site.page} />
        {config.managedSalesWebhooksEnabled ? <Suspense fallback={<p role="status" className="mt-4 text-sm text-muted">事務局振込の状態を読み込んでいます…</p>}>
          <HostManagedCompensationPanel provider={provider} />
        </Suspense> : null}
        <Suspense fallback={<p role="status" className="mt-4 text-sm text-muted">決済費用の実費を読み込んでいます…</p>}>
          <HostExperienceSettlementPanel provider={provider} />
        </Suspense>
        <Suspense fallback={<SalesPayoutsMessage text={SITE_PAYOUTS_LOADING_TEXT} />}>
          <HostSalesPayouts provider={provider} reader={reader} month={site.page.month} stripeLoginProviderId={stripeLoginProviderId} />
        </Suspense>
      </SalesFrame>
    );
  }
  if (site.status === "error") {
    return (
      <SalesFrame>
        {noticeView}
        <p role="alert" className="rounded-2xl border border-warn/20 bg-warn-pale px-4 py-3 text-warn">
          {SITE_SALES_LOAD_FAILED_TEXT}
        </p>
      </SalesFrame>
    );
  }

  const list = loadHostSales(provider);
  if (list.status === "unavailable") {
    return (
      <SalesFrame>
        {noticeView}
        <section className={`${HOST_SURFACE} px-5 py-8 md:px-6 md:py-10`}>
          <p className="font-extrabold">売上の明細は準備中です</p>
          <p className="mt-1 text-ink-soft">売上・手数料・返金・入金の確認は、NIHO との接続ができしだいここから行えるようになります。</p>
        </section>
      </SalesFrame>
    );
  }

  const page = salesPage(list.sales, list.period, month);
  return (
    <SalesFrame page={page} linkProviderId={linkProviderId}>
      {noticeView}
      <SalesSummaryPanel page={page} />
      <SalesLines page={page} />
    </SalesFrame>
  );
}

async function HostManagedCompensationPanel({ provider }: { provider: HostProvider }) {
  const repository = managedExperienceSalesRepository();
  if (!repository) return null;
  const rows = await repository.listHostCompensations(ownerActor(provider)).catch(() => null);
  if (rows === null) return <p role="alert" className="mt-4 rounded-xl bg-warn-pale p-3 text-sm text-warn">事務局振込の状態を読み込めませんでした。</p>;
  if (!rows.length) return null;
  const status: Record<(typeof rows)[number]["status"], string> = {
    REVIEW_REQUIRED: "確認中", READY: "振込準備前", PREPARED: "振込準備済み", RESULT_UNKNOWN: "明細照合中",
    PAID: "振込済み", ADJUSTMENT_REQUIRED: "支払後の調整あり",
  };
  return <section className={`${HOST_SURFACE} mt-4 p-4 md:p-5`} aria-labelledby="managed-compensation-title">
    <h2 id="managed-compensation-title" className="font-extrabold">事務局からの報酬振込</h2>
    <p className="mt-1 text-sm text-muted">完全代行で受けた予約の報酬です。Stripeの口座入金とは別に、開催後に事務局が銀行振込します。</p>
    <ul className="mt-3 divide-y divide-line">{rows.map((row) => <li key={row.publicBookingId} className="grid gap-1 py-3 text-sm sm:grid-cols-[1fr_auto]">
      <span className="break-all font-bold">予約 {row.publicBookingId}</span><span>{row.currency === "JPY" ? `${row.providerAmount.toLocaleString("ja-JP")}円` : `${row.providerAmount} ${row.currency}`}</span>
      <span className="text-muted">支払期日 {row.dueOn}</span><span className="font-bold">{status[row.status]}</span>
    </li>)}</ul>
  </section>;
}

async function HostExperienceSettlementPanel({ provider }: { provider: HostProvider }) {
  const repository = experienceSupportRepository();
  if (!repository) return <p role="alert" className="mt-4 rounded-xl bg-warn-pale p-3 text-sm text-warn">決済費用の実費を読み込めません。データベース接続を確認してください。</p>;
  let summaries: Awaited<ReturnType<typeof repository.listHostSummaries>> | null = null;
  let failed = false;
  try {
    summaries = await repository.listHostSummaries(ownerActor(provider), 100);
  } catch {
    failed = true;
  }
  if (failed || summaries === null) return <p role="alert" className="mt-4 rounded-xl bg-warn-pale p-3 text-sm text-warn">決済費用の実費を読み込めません。権限またはデータベース接続を確認して再読み込みしてください。</p>;
  return <SettlementSummaryList items={summaries} heading="Experience予約の決済費用精算" />;
}

/** この口座への入金 for the month shown: nothing when it is not open to this account, a message when Stripe fails. */
async function HostSalesPayouts({ provider, reader, month, stripeLoginProviderId }: Pick<MonthProps, "provider" | "reader"> & { month: SalesMonth; stripeLoginProviderId: string | null }) {
  const payouts = await loadSitePayouts(provider, reader, month);
  if (payouts.status === "closed") return null;
  if (payouts.status === "error") return <SalesPayoutsMessage text={payouts.text} failed providerId={stripeLoginProviderId} />;
  return <SalesPayoutsPanel panel={payouts.panel} />;
}
