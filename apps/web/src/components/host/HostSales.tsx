import Link from "next/link";
import type { ReactNode } from "react";
import { STRIPE_DASHBOARD_URL, type SalesPayoutNotice } from "@/host/payout";
import { monthKey, type SalesMonth, type SalesPage, type SalesRow } from "@/host/sales";
import { SITE_PAYOUTS_EMPTY_TEXT, SITE_PAYOUTS_SCOPE_TEXT, SITE_PAYOUTS_TITLE, type SitePayoutsPanel } from "@/host/site-sales-payouts";
import { HOST_SALES_PATH, withQuery } from "@/lib/host/routes";
import { HostIcon } from "./HostIcon";
import { consoleButtonClass, HOST_HEADING, HOST_SURFACE } from "./host-ui";
import { SectionTitle, StatusPill } from "./ui";

/*
 * 売上 (#91, mock v2 `screenSales`): the month switch beside the title, the note when the payout
 * account is not ready, the month's numbers and its ledger lines. Server components: the month
 * is the page's own `?month=` (with `?providerId=`).
 */

const ROUND = "grid size-[30px] shrink-0 place-items-center rounded-full border border-line-strong text-ink";

/** ‹ 2026年10月 ›: links to the months next to this one; at either end of the period the arrow is only drawn. */
export function SalesMonthNav({ page, providerId }: { page: SalesPage; providerId: string | null }) {
  const href = (month: SalesMonth) => withQuery(HOST_SALES_PATH, { month: monthKey(month), providerId });
  const arrow = (month: SalesMonth | null, label: string, icon: "chevronLeft" | "chevronRight") =>
    month ? (
      <Link href={href(month)} aria-label={label} className={`${ROUND} hover:bg-sand`}>
        <HostIcon name={icon} className="size-4" />
      </Link>
    ) : (
      <span aria-hidden="true" className={`${ROUND} opacity-45`}>
        <HostIcon name={icon} className="size-4" />
      </span>
    );
  return (
    <nav aria-label="表示する月" className="inline-flex items-center gap-1.5 font-extrabold">
      {arrow(page.previous, "前の月", "chevronLeft")}
      <span className="px-0.5 whitespace-nowrap">{page.label}</span>
      {arrow(page.next, "次の月", "chevronRight")}
    </nav>
  );
}

/** Above 売上 when the money cannot reach the host yet: what is missing and the way to 設定 › 売上受取口座. */
export function SalesPayoutNoticeView({ notice, settingsHref }: { notice: SalesPayoutNotice; settingsHref: string }) {
  if (notice.kind !== "setup") return <p className="mb-3.5 text-[0.8125rem] text-muted">{notice.text}</p>;
  return (
    <section aria-labelledby="sales-payout-notice" className="mb-3.5 flex flex-wrap items-center gap-x-4 gap-y-2.5 rounded-2xl border border-warn/20 bg-warn-pale px-4 py-3 md:px-5">
      <div className="min-w-0 flex-[1_1_220px]">
        <h2 id="sales-payout-notice" className={`${HOST_HEADING} text-[0.875rem] leading-normal text-warn`}>
          {notice.title}
        </h2>
        <p className="text-[0.8125rem] text-ink-soft">{notice.text}</p>
      </div>
      <Link href={settingsHref} className={consoleButtonClass("secondary", "sm")}>
        口座を設定
      </Link>
    </section>
  );
}

/**
 * The month's numbers (mock v2 `.stats`), the way to Stripe's own payout details, and the notes on what the numbers
 * leave out or work out (this site's ledger, #91).
 */
export function SalesSummaryPanel({ page }: { page: SalesPage }) {
  return (
    <section aria-labelledby="sales-summary" className={HOST_SURFACE}>
      <h2 id="sales-summary" className="sr-only">
        {page.label}の集計
      </h2>
      <div className="flex flex-wrap items-center gap-x-[22px] gap-y-3 px-4 py-4 md:px-5">
        <dl className="flex flex-wrap gap-x-[18px] gap-y-3 md:gap-x-[22px]">
          {page.figures.map(({ label, value }) => (
            <div key={label}>
              <dt className="text-xs font-bold text-muted">{label}</dt>
              <dd className="text-lg leading-[1.3] font-extrabold tabular-nums md:text-xl">{value}</dd>
            </div>
          ))}
        </dl>
        <a href={STRIPE_DASHBOARD_URL} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-6 items-center gap-0.5 text-[0.78125rem] font-extrabold text-ink-soft hover:text-ink md:ml-auto">
          <HostIcon name="external" className="size-3.5" />
          Stripe で入金の明細を見る
          <span className="sr-only">（新しいタブで開きます）</span>
        </a>
      </div>
      {page.notes.length ? (
        <ul className="space-y-1 border-t border-line px-4 py-3 text-[0.78125rem] leading-normal text-muted md:px-5">
          {page.notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

/** While the month is read (#91): where the numbers and lines will be. */
export function SalesLoading() {
  return (
    <section aria-busy="true" className={`${HOST_SURFACE} px-4 py-6 md:px-5`}>
      <p role="status" className="text-muted">
        売上を読み込んでいます…
      </p>
    </section>
  );
}

/** Above the numbers of this site's ledger (#91): whose sales these are, so NIHO's are not looked for here. */
export function SalesScope({ text }: { text: string }) {
  return <p className="mb-3.5 text-[0.8125rem] leading-normal text-ink-soft">{text}</p>;
}

/**
 * 明細: date, what it was, where it came from, the amount and its state. Only a refund is red with
 * a minus: a payout (口座入金) is money the host receives. Phones put the state after 補足.
 */
export function SalesLines({ page }: { page: SalesPage }) {
  return (
    <section aria-labelledby="sales-lines" className={`${HOST_SURFACE} mt-3.5`}>
      <h2 id="sales-lines" className="sr-only">
        {page.label}の明細
      </h2>
      {page.rows.length ? (
        <ul>
          {page.rows.map((row) => (
            <SalesRowItem key={row.key} row={row} />
          ))}
        </ul>
      ) : (
        <p className="px-4 py-6 text-muted md:px-5">この月の売上はまだありません</p>
      )}
    </section>
  );
}

/** One line of 明細 (and of この口座への入金): date, what it was, where from, the amount and its state. */
function SalesRowItem({ row }: { row: SalesRow }) {
  return (
    <li className="flex min-h-[52px] items-center gap-3 border-t border-line px-3.5 py-3 first:border-t-0 md:px-4">
      <time dateTime={row.date} className="w-[46px] shrink-0 text-[0.78125rem] text-muted tabular-nums">
        <span aria-hidden="true">{row.shortDate}</span>
        <span className="sr-only">{row.dateLabel}</span>
      </time>
      <div className="min-w-0 flex-1">
        <p className="text-[0.875rem] leading-[1.4] font-extrabold [overflow-wrap:anywhere]">{row.title}</p>
        <p className="text-[0.78125rem] leading-normal text-muted">
          {row.detail}
          <span className="md:hidden"> · {row.status.label}</span>
        </p>
      </div>
      <p className={`shrink-0 text-right font-extrabold whitespace-nowrap tabular-nums md:min-w-[88px] ${row.negative ? "text-danger" : ""}`}>{row.amount}</p>
      <span className="shrink-0 max-md:hidden">
        <StatusPill status={row.status} />
      </span>
    </li>
  );
}

const PAYOUTS_HEADING_ID = "sales-payouts";

/** この口座への入金's frame: its own title and the line that it is the account's money, not this site's. */
function SalesPayoutsFrame({ busy = false, children }: { busy?: boolean; children: ReactNode }) {
  return (
    <section aria-labelledby={PAYOUTS_HEADING_ID} aria-busy={busy || undefined} className={`${HOST_SURFACE} mt-3.5`}>
      <div className="px-4 pt-4 md:px-5">
        <SectionTitle id={PAYOUTS_HEADING_ID}>{SITE_PAYOUTS_TITLE}</SectionTitle>
        <p className="mt-1 text-[0.8125rem] leading-normal text-ink-soft">{SITE_PAYOUTS_SCOPE_TEXT}</p>
      </div>
      {children}
    </section>
  );
}

/**
 * この口座への入金 (#91): Stripe's payouts to the provider's account (mock v2's 入金予定・入金済み and 口座入金 lines),
 * under its own title below this site's numbers and lines, since the account takes NIHO's sales too.
 */
export function SalesPayoutsPanel({ panel }: { panel: SitePayoutsPanel }) {
  return (
    <SalesPayoutsFrame>
      <div className="flex flex-wrap items-center gap-x-[22px] gap-y-3 px-4 py-4 md:px-5">
        <dl className="flex flex-wrap gap-x-[18px] gap-y-3 md:gap-x-[22px]">
          {panel.figures.map(({ label, value }) => (
            <div key={label}>
              <dt className="text-xs font-bold text-muted">{label}</dt>
              <dd className="text-lg leading-[1.3] font-extrabold tabular-nums md:text-xl">{value}</dd>
            </div>
          ))}
        </dl>
      </div>
      {panel.notes.length ? (
        <ul className="space-y-1 px-4 pb-3 text-[0.78125rem] leading-normal text-muted md:px-5">
          {panel.notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      ) : null}
      <div className="border-t border-line">
        {panel.rows.length ? (
          <ul aria-label={`${SITE_PAYOUTS_TITLE}の明細`}>
            {panel.rows.map((row) => (
              <SalesRowItem key={row.key} row={row} />
            ))}
          </ul>
        ) : (
          <p className="px-4 py-6 text-muted md:px-5">{SITE_PAYOUTS_EMPTY_TEXT}</p>
        )}
      </div>
    </SalesPayoutsFrame>
  );
}

/** この口座への入金 while Stripe is read, or when it could not be: the words, and Stripe's own page when it failed. */
export function SalesPayoutsMessage({ text, failed = false }: { text: string; failed?: boolean }) {
  return (
    <SalesPayoutsFrame busy={!failed}>
      <div className="px-4 pt-3 pb-4 md:px-5">
        {failed ? (
          <>
            <p role="alert" className="rounded-2xl border border-warn/20 bg-warn-pale px-4 py-3 text-warn">
              {text}
            </p>
            <a href={STRIPE_DASHBOARD_URL} target="_blank" rel="noopener noreferrer" className="mt-2 inline-flex min-h-6 items-center gap-0.5 text-[0.78125rem] font-extrabold text-ink-soft hover:text-ink">
              <HostIcon name="external" className="size-3.5" />
              Stripe で入金の明細を見る
              <span className="sr-only">（新しいタブで開きます）</span>
            </a>
          </>
        ) : (
          <p role="status" className="text-muted">
            {text}
          </p>
        )}
      </div>
    </SalesPayoutsFrame>
  );
}
