import type { Metadata } from "next";
import { Suspense, type ReactNode } from "react";
import { HostRegisterPrompt } from "@/components/host/HostRegisterPrompt";
import { SalesLines, SalesLoading, SalesMonthNav, SalesPayoutNoticeView, SalesScope, SalesSummaryPanel } from "@/components/host/HostSales";
import { HOST_SURFACE } from "@/components/host/host-ui";
import { HostPageBody, PageHead } from "@/components/host/ui";
import { hostPageContext, loadHostPayout, loadHostSales } from "@/host/data";
import { notFound } from "next/navigation";
import { salesPayoutNotice } from "@/host/payout";
import { salesPage, type SalesPage } from "@/host/sales";
import { SITE_SALES_LOAD_FAILED_TEXT, SITE_SALES_SCOPE_TEXT } from "@/host/site-sales";
import { loadSiteSales } from "@/host/site-sales-server";
import type { HostProvider } from "@/lib/host/providers";
import { HOST_SETTINGS_PATH, withProvider } from "@/lib/host/routes";
import type { HostSession } from "@/lib/host/session";

export const metadata: Metadata = { title: "売上" };

type SearchParams = Record<string, string | string[] | undefined>;

interface MonthProps {
  provider: HostProvider;
  /** Who reads: never the session's tokens. */
  reader: Pick<HostSession, "nihoUserId" | "mockScenario">;
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
 * site's only. What Stripe pays out to the bank stays Stripe's: the page leads there and makes none of it up. The
 * month streams in after the OWNER check, so anyone else still gets a 404.
 */
export default async function HostSalesPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const query = await searchParams;
  const context = await hostPageContext(query);
  // The console layout shows sign-in, refresh and error states.
  if (!context) return null;
  const { provider, linkProviderId } = context;
  if (!provider) return <HostRegisterPrompt title="売上" />;
  if (provider.memberRole !== "OWNER") notFound();
  const reader = { nihoUserId: context.session.nihoUserId, mockScenario: context.session.mockScenario };
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
    return (
      <SalesFrame page={site.page} linkProviderId={linkProviderId}>
        <SalesScope text={SITE_SALES_SCOPE_TEXT} />
        {noticeView}
        <SalesSummaryPanel page={site.page} />
        <SalesLines page={site.page} />
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
