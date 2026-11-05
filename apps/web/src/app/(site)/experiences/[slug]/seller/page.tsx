import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { cancellationSummary, scheduleDescription } from "@/lib/experience/site-card-model";
import { getSitePublicExperience } from "@/lib/experience/site-publications";
import { formatYen } from "@/lib/format";

type Props = { params: Promise<{ slug: string }> };
export const dynamic = "force-dynamic";
export const revalidate = 0;

async function nativeSeller(slug: string) {
  const lookup = await getSitePublicExperience(slug);
  return lookup?.kind === "published" && lookup.item.sellerDisclosure?.method === "NATIVE" ? lookup.item : null;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const item = await nativeSeller((await params).slug);
  return item ? { title: `Seller information for ${item.publication.publicTitle}` } : { title: "Seller information", robots: { index: false, follow: false } };
}

export default async function SellerInformationPage({ params }: Props) {
  const item = await nativeSeller((await params).slug);
  if (!item || item.sellerDisclosure?.method !== "NATIVE") notFound();
  const { publication, saleTerms, sellerDisclosure: seller } = item;
  const rows = [
    ["Seller type", seller.sellerKind === "PERSON" ? "Individual" : "Business"],
    ["Seller", seller.sellerDisplayName],
    ...(seller.representativeName ? [["Responsible person", seller.representativeName]] : []),
    ["Public address", seller.publicAddress],
    ["Public phone", seller.publicPhone],
    ["Public email", seller.publicEmail],
  ];
  return <main id="main" className="container-page py-10 sm:py-14">
    <nav aria-label="Breadcrumb" className="text-sm text-muted"><Link className="font-bold text-ink hover:underline" href={`/experiences/${encodeURIComponent(publication.slug)}`}>{publication.publicTitle}</Link><span aria-hidden> / </span><span aria-current="page">Seller information</span></nav>
    <div className="mt-6 max-w-3xl"><p className="eyebrow">Seller disclosure</p><h1 className="mt-2 text-3xl sm:text-4xl">Seller information</h1><p className="mt-4 text-ink-soft">Contact details and current booking terms for this experience.</p>
      <section className="mt-8 rounded-[var(--radius-card)] border border-line bg-white p-5 sm:p-7"><h2 className="text-2xl">Public contact details</h2><dl className="mt-5 divide-y divide-line">{rows.map(([label, value]) => <div key={label} className="grid gap-1 py-3 sm:grid-cols-[180px_1fr]"><dt className="font-bold text-ink-soft">{label}</dt><dd className="whitespace-pre-line break-words">{label === "Public email" ? <a className="underline" href={`mailto:${value}`}>{value}</a> : value}</dd></div>)}</dl></section>
      <section className="mt-6 rounded-[var(--radius-card)] border border-line bg-white p-5 sm:p-7"><h2 className="text-2xl">Current terms for this experience</h2>{saleTerms?.offers.length ? <ul className="mt-5 space-y-5">{saleTerms.offers.map((offer) => <li key={offer.id} className="border-b border-line pb-5 last:border-0 last:pb-0"><h3 className="font-extrabold">{offer.name}</h3><dl className="mt-2 grid gap-2 text-sm sm:grid-cols-2"><div><dt className="font-bold text-ink-soft">Price</dt><dd>{formatYen(offer.pricing.adultPriceYen, "en")} per adult{offer.pricing.child ? `; ${formatYen(offer.pricing.child.priceYen, "en")} per child` : ""}</dd></div><div><dt className="font-bold text-ink-soft">When offered</dt><dd>{scheduleDescription(offer)}</dd></div><div className="sm:col-span-2"><dt className="font-bold text-ink-soft">Cancellation and refund</dt><dd>{cancellationSummary(offer)}</dd></div></dl></li>)}</ul> : <div className="mt-4"><p>Online booking is not currently available. The published base price is {formatYen(publication.unitAmount, "en")}.</p><p className="mt-2 text-sm text-muted">No schedule or cancellation/refund terms are currently open for booking.</p></div>}</section>
    </div>
  </main>;
}
