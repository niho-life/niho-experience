import { SiteSellerInformationPage, siteSellerInformationMetadata } from "@/components/pages/SiteSellerInformationPage";

type Props = { params: Promise<{ slug: string }> };
export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function generateMetadata({ params }: Props) {
  return siteSellerInformationMetadata((await params).slug, "en");
}

export default async function SellerInformationPage({ params }: Props) {
  return SiteSellerInformationPage({ slug: (await params).slug, locale: "en" });
}
