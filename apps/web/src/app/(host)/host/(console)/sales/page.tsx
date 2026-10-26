import type { Metadata } from "next";
import { HostRegisterPrompt } from "@/components/host/HostRegisterPrompt";
import { SalesLines, SalesMonthNav, SalesPayoutNoticeView, SalesSummaryPanel } from "@/components/host/HostSales";
import { HOST_SURFACE } from "@/components/host/host-ui";
import { HostPageBody, PageHead } from "@/components/host/ui";
import { hostPageContext, loadHostPayout, loadHostSales } from "@/host/data";
import { notFound } from "next/navigation";
import { salesPayoutNotice } from "@/host/payout";
import { salesPage } from "@/host/sales";
import { HOST_SETTINGS_PATH, withProvider } from "@/lib/host/routes";

export const metadata: Metadata = { title: "売上" };

type SearchParams = Record<string, string | string[] | undefined>;

/**
 * 売上 (#91, mock v2): one month of sales, fees, refunds and payouts (`?month=YYYY-MM`) and the
 * note when the payout account is not ready yet (NIHO's readiness, the owner's to read). The
 * ledger is synthetic in mock mode; http mode says 準備中 until NIHO's API has sales.
 */
export default async function HostSalesPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const query = await searchParams;
  const context = await hostPageContext(query);
  // The console layout shows sign-in, refresh and error states.
  if (!context) return null;
  const { provider, linkProviderId } = context;
  if (!provider) return <HostRegisterPrompt title="売上" />;
  if (provider.memberRole !== "OWNER") notFound();
  const list = loadHostSales(provider);
  const payout = await loadHostPayout(provider, { candidates: false });
  const notice = salesPayoutNotice(payout.load);
  const noticeView = notice ? <SalesPayoutNoticeView notice={notice} settingsHref={`${withProvider(HOST_SETTINGS_PATH, linkProviderId)}#settings-payout`} /> : null;

  if (list.status === "unavailable") {
    return (
      <HostPageBody>
        <PageHead title="売上" />
        {noticeView}
        <section className={`${HOST_SURFACE} px-5 py-8 md:px-6 md:py-10`}>
          <p className="font-extrabold">売上の明細は準備中です</p>
          <p className="mt-1 text-ink-soft">売上・手数料・返金・入金の確認は、NIHO との接続ができしだいここから行えるようになります。</p>
        </section>
      </HostPageBody>
    );
  }

  const page = salesPage(list.sales, list.period, query.month);
  return (
    <HostPageBody>
      <PageHead title="売上">
        <SalesMonthNav page={page} providerId={linkProviderId} />
      </PageHead>
      {noticeView}
      <SalesSummaryPanel page={page} />
      <SalesLines page={page} />
    </HostPageBody>
  );
}
