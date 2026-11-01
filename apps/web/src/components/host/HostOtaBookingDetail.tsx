"use client";

import { useId, type ReactNode } from "react";
import { bookingWhen, shortDateTime } from "@/host/bookings";
import {
  OTA_BOOKING_ERASED_TEXT,
  OTA_BOOKING_NO_DETAILS_TEXT,
  OTA_BOOKING_PENDING_TEXT,
  OTA_BOOKING_REVIEW_TEXT,
  otaBookingOnSiteText,
  otaStatusLabel,
} from "@/host/ota-bookings";
import { telHref } from "@/host/session";
import type { HostBooking } from "@/host/types";
import { HOST_SURFACE } from "./host-ui";
import { StatusPill } from "./ui";

/** Where an OTA booking came from: the site's name as a small badge (予約's rows and the detail, #194). */
export function OtaSourceBadge({ site }: { site: string }) {
  return (
    <span className="inline-flex h-5 shrink-0 items-center rounded-full border border-line-strong bg-canvas px-2 text-[0.6875rem] leading-none font-extrabold whitespace-nowrap text-ink-soft">
      <span className="sr-only">予約サイト </span>
      {site}
    </span>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="mt-3.5 border-t border-line pt-3.5">
      <h3 id={id} className="mb-2 font-sans text-xs leading-normal font-extrabold tracking-[0.04em] text-ink-soft">
        {title}
      </h3>
      {children}
    </section>
  );
}

/** Label 72px + value, as the bookings' own detail (mock v2 `.dkv`). */
function Rows({ rows }: { rows: readonly (readonly [string, ReactNode])[] }) {
  return (
    <dl>
      {rows.map(([label, value]) => (
        <div key={label} className="grid grid-cols-[72px_minmax(0,1fr)] gap-2 py-[5px] text-[0.8125rem] leading-normal">
          <dt className="font-bold text-muted">{label}</dt>
          <dd className="min-w-0 [overflow-wrap:anywhere]">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

const LINK = "font-bold text-moss underline underline-offset-2";

/**
 * 予約 › one booking made on a reservation site (#194 PR B, owner decision 2026-11-01): who booked, how many, how to reach
 * them and the site's booking reference, so the host can find it there. The site keeps the booking: cancelling, refunding
 * and writing to the guest happen there, so this says so and offers no action. No amount (the ledger keeps none).
 */
export function HostOtaBookingDetail({ booking, experienceTitle, today, headingId }: { booking: HostBooking; experienceTitle: string; today: string; headingId: string }) {
  const ota = booking.ota!;
  const people = ota.party ? `${booking.guests}名（${ota.party}）` : `${booking.guests}名`;
  const contact: (readonly [string, ReactNode])[] = [
    ...(ota.email ? [["メール", <a key="email" href={`mailto:${ota.email}`} className={LINK}>{ota.email}</a>] as const] : []),
    ...(ota.phone ? [["電話", <a key="phone" href={telHref(ota.phone)} className={LINK}>{ota.phone}</a>] as const] : []),
    ...(ota.languageTag ? [["言語", <span key="language" lang={ota.languageTag}>{ota.languageTag}</span>] as const] : []),
  ];
  return (
    <section aria-labelledby={headingId} className={`${HOST_SURFACE} p-4 md:px-5 md:py-[18px]`}>
      <div className="flex items-start justify-between gap-2.5">
        <div className="min-w-0">
          <h2 id={headingId} tabIndex={-1} className="font-sans text-[1.125rem] leading-[1.3] font-extrabold tracking-normal [overflow-wrap:anywhere] focus:outline-none">
            {booking.guest}
          </h2>
          <p className="mt-0.5 text-[0.78125rem] leading-normal text-muted">{bookingWhen(booking)}</p>
        </div>
        <StatusPill status={otaStatusLabel(booking, today)} />
      </div>
      <p className="mt-3 rounded-xl bg-sand px-3 py-2 text-[0.8125rem] leading-normal text-ink">{otaBookingOnSiteText(ota.siteLabel)}</p>
      {ota.pending ? <p className="mt-2 text-[0.8125rem] leading-normal font-extrabold text-warn">{OTA_BOOKING_PENDING_TEXT}</p> : null}
      {ota.needsReview ? <p className="mt-2 text-[0.8125rem] leading-normal font-extrabold text-warn">{OTA_BOOKING_REVIEW_TEXT}</p> : null}

      <Section title="申込内容">
        <Rows
          rows={[
            ["予約サイト", <OtaSourceBadge key="site" site={ota.siteLabel} />],
            ["体験", experienceTitle || booking.offer],
            ["人数", people],
            ...(ota.bookingReference ? [["予約番号", <span key="reference" className="font-mono tabular-nums">{ota.bookingReference}</span>] as const] : []),
          ]}
        />
      </Section>
      <Section title="予約者">
        {ota.erased ? (
          <p className="text-[0.8125rem] leading-normal text-muted">{OTA_BOOKING_ERASED_TEXT}</p>
        ) : !ota.hasDetails ? (
          <p className="text-[0.8125rem] leading-normal text-muted">{OTA_BOOKING_NO_DETAILS_TEXT}</p>
        ) : (
          <>
            <Rows rows={[["名前", booking.guest], ...contact]} />
            {ota.notes ? (
              <div className="mt-1.5 text-[0.8125rem] leading-normal">
                <p className="font-bold text-muted">予約サイトへのメモ</p>
                <p className="mt-0.5 whitespace-pre-line [overflow-wrap:anywhere]" lang={ota.languageTag ?? undefined}>{ota.notes}</p>
              </div>
            ) : null}
          </>
        )}
      </Section>
      <Section title="時系列">
        <ol>
          {booking.timeline.map((event, index) => (
            <li key={index} className="flex gap-2.5 py-1 text-[0.78125rem] leading-normal">
              <time dateTime={`${event.at}+09:00`} className="w-[92px] shrink-0 text-muted tabular-nums">
                {shortDateTime(event.at)}
              </time>
              <span className="min-w-0 [overflow-wrap:anywhere]">{event.text}</span>
            </li>
          ))}
        </ol>
      </Section>
    </section>
  );
}
