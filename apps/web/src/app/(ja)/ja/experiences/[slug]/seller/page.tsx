import { SiteSellerInformationPage, siteSellerInformationMetadata } from "@/components/pages/SiteSellerInformationPage";

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props) {
  return siteSellerInformationMetadata((await params).slug, "ja");
}

export default async function JapaneseSellerInformationPage({ params }: Props) {
  return SiteSellerInformationPage({ slug: (await params).slug, locale: "ja" });
}
