import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PersonPage } from "@/components/pages/PeoplePages";
import { loadPerson } from "@/lib/ja-people";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const data = await loadPerson((await params).slug);
  if (!data) return { title: "街の人", robots: { index: false, follow: false } };
  const { person } = data;
  return { title: `${person.name}（${person.roleJa}）`, description: person.quoteJa ?? `${person.areaJa}の${person.roleJa}、${person.name}さん。` };
}

export default async function JapanesePersonPage({ params }: Props) {
  const data = await loadPerson((await params).slug);
  if (!data) notFound();
  return <PersonPage person={data.person} experiences={data.experiences} />;
}
