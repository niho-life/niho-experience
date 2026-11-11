import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { cache, type ReactNode } from "react";
import { config } from "@/lib/config";
import { cancellationSummary, scheduleDescription } from "@/lib/experience/site-card-model";
import { getSitePublicExperience } from "@/lib/experience/site-publications";
import { formatDuration, formatYen } from "@/lib/format";

type Locale = "en" | "ja";

const nativeSeller = cache(async (slug: string, locale: Locale) => {
  const lookup = await getSitePublicExperience(slug);
  if (lookup?.kind !== "published" || (locale === "ja" && !lookup.item.publication.japanese)) return null;
  const seller = lookup.item.sellerDisclosure;
  return seller?.method === "NATIVE" ? { ...lookup.item, seller } : null;
});

export async function siteSellerInformationMetadata(slug: string, locale: Locale): Promise<Metadata> {
  const item = await nativeSeller(slug, locale);
  const title = locale === "ja" ? "特定商取引法に基づく表記" : "Seller information";
  return item
    ? { title: locale === "ja" ? `${title} | ${item.publication.japanese!.title}` : `${title} for ${item.publication.publicTitle}` }
    : { title, robots: { index: false, follow: false } };
}

export async function SiteSellerInformationPage({ slug, locale }: { slug: string; locale: Locale }) {
  const item = await nativeSeller(slug, locale);
  if (!item) notFound();
  const { publication, saleTerms, seller } = item;
  const ja = locale === "ja";
  const title = ja ? "特定商取引法に基づく表記" : "Seller information";
  const offers = saleTerms?.offers ?? [];
  const hasPaidOffer = offers.some(({ pricing }) => pricing.adultPriceYen > 0 || (pricing.child?.priceYen ?? 0) > 0);
  const experiencePath = `/experiences/${encodeURIComponent(publication.slug)}`;
  const experienceHref = ja ? `/ja${experiencePath}` : experiencePath;
  const contactDetails: [string, ReactNode][] = [
    [ja ? "販売事業者" : "Seller", seller.sellerDisplayName],
    [ja ? "運営責任者" : "Responsible person", seller.representativeName],
    [ja ? "所在地" : "Address", seller.publicAddress],
    [ja ? "電話番号" : "Phone", seller.publicPhone],
    [ja ? "メールアドレス" : "Email", <a key="email" className="underline" href={`mailto:${seller.publicEmail}`}>{seller.publicEmail}</a>],
  ];

  return <div className="container-page py-10 sm:py-14">
    <nav aria-label={ja ? "パンくずリスト" : "Breadcrumb"} className="text-sm text-muted">
      <Link className="font-bold text-ink hover:underline" href={experienceHref}>
        {ja ? publication.japanese!.title : publication.publicTitle}
      </Link>
      <span aria-hidden> / </span><span aria-current="page">{title}</span>
    </nav>
    <div className="mt-6 max-w-3xl">
      <h1 className="text-3xl sm:text-4xl">{title}</h1>
      {config.japaneseSiteEnabled && publication.japanese ? (
        <Link href={`${ja ? "" : "/ja"}${experiencePath}/seller`} hrefLang={ja ? "en" : "ja"} className="mt-3 inline-block text-sm text-muted underline underline-offset-2">
          {ja ? "English" : "日本語"}
        </Link>
      ) : null}
      <section className="mt-8 rounded-[var(--radius-card)] border border-line bg-white p-5 sm:p-7">
        <h2 className="text-2xl">{ja ? "販売者と連絡先" : "Seller and contact details"}</h2>
        <dl className="mt-4 divide-y divide-line">
          {contactDetails.map(([label, value]) => value != null && (
            <div key={label} className="grid gap-1 py-3 sm:grid-cols-[180px_1fr]">
              <dt className="font-bold text-ink-soft">{label}</dt>
              <dd className="whitespace-pre-line break-words">{value}</dd>
            </div>
          ))}
        </dl>
      </section>
      <section className="mt-6 rounded-[var(--radius-card)] border border-line bg-white p-5 sm:p-7">
        <h2 className="text-2xl">{ja ? "この体験の予約条件" : "Booking terms for this experience"}</h2>
        {offers.length ? <>
          <dl className="mt-4 grid gap-3 text-sm">
            <div>
              <dt className="font-bold text-ink-soft">{ja ? "お支払い方法・時期" : "Payment method and timing"}</dt>
              <dd>{hasPaidOffer
                ? ja ? "有料の予約は、予約時にStripe Checkoutでカード決済します。" : "For paid bookings, pay by card through Stripe Checkout when you book."
                : ja ? "お支払いは不要です。" : "No payment is required."}</dd>
            </div>
            <div>
              <dt className="font-bold text-ink-soft">{ja ? "提供時期" : "When the experience takes place"}</dt>
              <dd>{ja ? "予約時に選択した日時に開催します。" : "The experience takes place on the date and at the time you select when booking."}</dd>
            </div>
          </dl>
          <ul className="mt-5 divide-y divide-line border-t border-line">
            {offers.map((offer) => {
              const { adultPriceYen, child } = offer.pricing;
              return <li key={offer.id} className="py-4 last:pb-0">
                <h3 className="font-extrabold">{ja ? publication.japanese!.title : offer.name}</h3>
                <dl className="mt-2 grid gap-3 text-sm sm:grid-cols-2">
                  <div>
                    <dt className="font-bold text-ink-soft">{ja ? "料金（税込）" : "Price (tax included)"}</dt>
                    <dd>{ja ? `大人1名 ${formatYen(adultPriceYen, locale)}` : `${formatYen(adultPriceYen, locale)} per adult`}</dd>
                    {child ? <dd>{ja
                      ? `子ども1名（${child.minAge}〜${child.maxAge}歳） ${formatYen(child.priceYen, locale)}${child.adultRequired ? "（大人同伴）" : ""}`
                      : `${formatYen(child.priceYen, locale)} per child (ages ${child.minAge}–${child.maxAge})${child.adultRequired ? " · An adult must accompany children" : ""}`}</dd> : null}
                    {offer.minimumChargeableParticipants > 1 ? (
                      <dd>{ja ? `最低請求人数は${offer.minimumChargeableParticipants}名です。` : `Minimum charge: ${offer.minimumChargeableParticipants} guests.`}</dd>
                    ) : null}
                  </div>
                  <div>
                    <dt className="font-bold text-ink-soft">{ja ? "通常の開催日時・所要時間" : "Usual schedule and duration"}</dt>
                    <dd>{scheduleDescription(offer, locale)} · {formatDuration(offer.durationMinutes, locale)}</dd>
                  </div>
                  <div className="sm:col-span-2">
                    <dt className="font-bold text-ink-soft">{ja ? "キャンセル・返金" : "Cancellation and refunds"}</dt>
                    <dd>{cancellationSummary(offer, locale)}</dd>
                  </div>
                </dl>
              </li>;
            })}
          </ul>
        </> : (
          <p className="mt-4">{ja
            ? `現在、オンライン予約は受け付けていません。掲載の基本料金は${formatYen(publication.unitAmount, locale)}です。`
            : `Online booking is not currently available. The published base price is ${formatYen(publication.unitAmount, locale)}.`}</p>
        )}
      </section>
    </div>
  </div>;
}
