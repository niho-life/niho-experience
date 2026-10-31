import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { HostAppBadge } from "@/components/host/HostAppWindow";
import { HostHomeTodos } from "@/components/host/HostHomeTodos";
import { HostIcon } from "@/components/host/HostIcon";
import { HostRegisterPrompt } from "@/components/host/HostRegisterPrompt";
import { consoleButtonClass, HOST_SURFACE, LIST_ROW, LIST_ROW_DETAIL, LIST_ROW_TITLE } from "@/components/host/host-ui";
import { HostPageBody, MoreLink, PageHead, SectionTitle } from "@/components/host/ui";
import { homeCalendarPrompt, type HomeCalendarPrompt } from "@/host/calendar";
import { hostPageContext, loadHostConsoleData } from "@/host/data";
import { homeBadgeCount, type HomeUpcoming } from "@/host/home";
import { config } from "@/lib/config";
import { HOST_BOOKINGS_PATH, HOST_SALES_PATH, HOST_SETTINGS_PATH, withProvider } from "@/lib/host/routes";
import { isHostMock } from "@/lib/host/server";
import { resolveCalendarContext } from "@/lib/experience/calendar-actor";

export const metadata: Metadata = { title: "ホーム" };

type SearchParams = Record<string, string | string[] | undefined>;

/** The day of a session: its weekday over the day (the full date for screen readers). */
function SessionDay({ item }: { item: HomeUpcoming }) {
  return (
    <>
      <span className="sr-only">{item.dateLabel}</span>
      <span aria-hidden="true" className="w-11 shrink-0 text-center leading-[1.1]">
        <span className="block text-xs font-extrabold text-muted">{item.weekday}</span>
        <span className="mt-0.5 block font-display text-[1.3125rem] font-medium">{item.day}</span>
      </span>
    </>
  );
}

/**
 * 今日の開催 / 明日の開催 (#106): each session with its seats, its guests' food wishes and 参加者を見る
 * (この回, #107). Today's rows say where each stands (開始前・開催中・終了), and when a session is over
 * with attendance still to record. Not shown on a day without sessions.
 */
function DaySessions({ id, title, sessions, link }: { id: string; title: string; sessions: readonly HomeUpcoming[]; link: (href: string) => string }) {
  if (!sessions.length) return null;
  return (
    <section aria-labelledby={id} className={`${HOST_SURFACE} mt-3.5`}>
      <div className="px-4 pt-4 pb-2 md:px-5">
        <SectionTitle id={id}>{title}</SectionTitle>
      </div>
      <ul>
        {sessions.map((item, index) => (
          <li key={item.key} className={`${LIST_ROW} flex-wrap border-t border-line first:border-t-0`}>
            <SessionDay item={item} />
            <span id={`${id}-${index}`} className="min-w-0 flex-[1_1_150px]">
              {item.phase ? <span className={`block text-xs leading-normal font-extrabold ${item.phase.tone === "warn" ? "text-warn" : "text-muted"}`}>{item.phase.text}</span> : null}
              <span className={`block ${LIST_ROW_TITLE}`}>{item.title}</span>
              <span className={`block ${LIST_ROW_DETAIL}`}>{item.detail}</span>
              {item.dietary ? <span className={`block ${LIST_ROW_DETAIL}`}>{item.dietary}</span> : null}
            </span>
            <span className="shrink-0 text-[0.875rem] leading-[1.4] font-extrabold whitespace-nowrap tabular-nums max-md:ml-14">
              {item.seats} · {item.bookings}
            </span>
            <Link href={link(item.href)} aria-describedby={`${id}-${index}`} className={consoleButtonClass("secondary", "sm", "max-md:ml-auto")}>
              参加者を見る
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * The card while Google Calendar is not connected, or lost its access (#109, the journey mock's H1):
 * つなぐ opens 設定 › カレンダー. It stays until the calendar is connected (nothing closes it).
 */
function CalendarPromptCard({ prompt, href }: { prompt: HomeCalendarPrompt; href: string }) {
  return (
    <section aria-labelledby="home-calendar" className="mt-3.5 flex flex-wrap items-center gap-3 rounded-2xl bg-sand px-4 py-3.5 md:px-5">
      <span aria-hidden="true" className="grid size-10 shrink-0 place-items-center rounded-xl bg-canvas text-[1.0625rem] font-extrabold">
        G
      </span>
      <div className="min-w-0 flex-[1_1_170px]">
        <h2 id="home-calendar" className="font-sans text-[0.875rem] leading-[1.4] font-extrabold tracking-normal">
          {prompt.title}
        </h2>
        <p className="text-[0.8125rem] leading-normal text-ink-soft">{prompt.text}</p>
      </div>
      <Link href={href} aria-describedby="home-calendar" className={consoleButtonClass("secondary", "sm", "max-md:ml-auto")}>
        {prompt.action}
      </Link>
    </section>
  );
}

/**
 * ホーム (mock v2, the journey mock's H1): what needs doing, today's and tomorrow's sessions, the
 * calendar's card while Google Calendar is not connected (#109), the sessions after, and this month's numbers.
 */
export default async function HostHomePage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const query = await searchParams;
  const context = await hostPageContext(query);
  // The console layout shows sign-in, refresh and error states.
  if (!context) return null;
  const { provider, providerNotFound, linkProviderId } = context;
  const calendar = await resolveCalendarContext(query);
  if (calendar?.choice?.kind === "OPERATOR") redirect(withProvider("/host/calendar", calendar.choice.id));
  if (!provider) {
    return <HostRegisterPrompt title="ホーム" />;
  }
  // TODO(#285): the bookings made on this site (experience DB, 予約) join 今日・明日・これからの開催 once この回
  // reads them; until then their 参加者を見る would open a screen that does not have them.
  const { home, settings } = await loadHostConsoleData(provider);
  const link = (path: string) => withProvider(path, linkProviderId);
  // Only where it can be connected: the preview (http mode waits for NIHO's Google connection, #87).
  const calendarPrompt = homeCalendarPrompt(settings.calendar, isHostMock());
  // これからの開催 starts after the days shown above it.
  const upcoming = home.sessions.later;
  const soon = home.sessions.today.length + home.sessions.tomorrow.length > 0;

  return (
    <HostPageBody>
      <PageHead title="ホーム" />
      {providerNotFound ? (
        <p role="alert" className="mb-3.5 rounded-2xl border border-warn/20 bg-warn-pale px-4 py-3 text-warn">
          指定された提供者を開けませんでした。権限が無いか、URL が正しくありません。{provider.displayName}を表示しています。
        </p>
      ) : null}

      {/* Keyed by provider: another provider's rows start from their own list. */}
      <HostHomeTodos key={provider.id} todos={home.todos} providerId={linkProviderId} />
      <HostAppBadge enabled={config.hostPwaEnabled} count={homeBadgeCount(home.todos)} />
      <DaySessions id="home-today" title="今日の開催" sessions={home.sessions.today} link={link} />
      <DaySessions id="home-tomorrow" title="明日の開催" sessions={home.sessions.tomorrow} link={link} />
      {/* Under the day's sessions: what needs doing and who comes first, the calendar after them. */}
      {calendarPrompt ? <CalendarPromptCard prompt={calendarPrompt} href={link(`${HOST_SETTINGS_PATH}#settings-calendar`)} /> : null}

      <div className="mt-3.5 grid items-start gap-3.5 md:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <section aria-labelledby="home-upcoming" className={HOST_SURFACE}>
          <div className="flex items-center justify-between gap-2.5 px-4 pt-4 pb-2 md:px-5">
            <SectionTitle id="home-upcoming">これからの開催</SectionTitle>
            <MoreLink href={link(HOST_BOOKINGS_PATH)}>予約を見る</MoreLink>
          </div>
          {upcoming.length ? (
            <ul>
              {upcoming.map((item) => (
                <li key={item.key} className="border-t border-line first:border-t-0">
                  <Link href={link(item.href)} className={`${LIST_ROW} hover:bg-sand/60`}>
                    <SessionDay item={item} />
                    <span className="min-w-0 flex-1">
                      <span className={`block ${LIST_ROW_TITLE}`}>{item.title}</span>
                      <span className={`block ${LIST_ROW_DETAIL}`}>{item.detail}</span>
                    </span>
                    <span className="shrink-0 text-right">
                      <span className="block text-[0.875rem] leading-[1.4] font-extrabold whitespace-nowrap">{item.seats}</span>
                      <span className={`block ${LIST_ROW_DETAIL}`}>{item.bookings}</span>
                    </span>
                    <HostIcon name="chevronRight" className="size-4 text-line-strong max-md:hidden" />
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <p className="px-4 pb-4 text-muted md:px-5">{soon ? "明後日からの開催はまだありません。" : "これからの開催はまだありません。"}</p>
          )}
        </section>

        {provider.memberRole === "OWNER" ? <section aria-labelledby="home-month" className={HOST_SURFACE}>
          <div className="flex items-center justify-between gap-2.5 px-4 pt-4 pb-2 md:px-5">
            <SectionTitle id="home-month">{home.month?.label ?? "今月"}</SectionTitle>
            <MoreLink href={link(HOST_SALES_PATH)}>売上を見る</MoreLink>
          </div>
          {home.month ? (
            <dl className="flex flex-wrap items-center gap-[18px] px-4 pb-[18px] md:gap-[22px] md:px-5">
              {[
                ["売上", home.month.sales],
                ["返金", home.month.refunds],
                ["入金予定", home.month.expected],
                ["確定した予約", home.month.confirmed],
              ].map(([label, value]) => (
                <div key={label}>
                  <dt className="text-xs font-bold text-muted">{label}</dt>
                  <dd className="text-lg leading-[1.3] font-extrabold tabular-nums md:text-xl">{value}</dd>
                </div>
              ))}
            </dl>
          ) : (
            <p className="px-4 pb-4 text-muted md:px-5">売上の集計は準備中です。</p>
          )}
        </section> : null}
      </div>
    </HostPageBody>
  );
}
