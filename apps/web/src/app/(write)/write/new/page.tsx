import type { Metadata } from "next";
import Link from "next/link";
import { NewGuideForm } from "@/components/write/NewGuideForm";
import { loadWritePageAccess, writeExperienceQuery } from "@/lib/write/page-access";

export const metadata: Metadata = { title: "新しい記事" };
export default async function WriteNewPage({ searchParams }: { readonly searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const query = writeExperienceQuery(await searchParams);
  if (!query.ok) return <main id="main" className="mx-auto max-w-3xl px-4 py-12"><h1 className="text-2xl">新しい記事</h1><p className="mt-4">URL の体験指定が正しくありません。記事は作成されていません。</p></main>;
  const experience = query.experience;
  const returnPath = experience ? `/write/new?experience=${encodeURIComponent(experience)}` : "/write/new";
  const access = await loadWritePageAccess(returnPath);
  if (!access.ok) return <main id="main" className="write-state"><h1>新しい記事</h1><p>{access.reason === "forbidden" ? "記事を書ける提供者 OWNER がありません。ホスト画面で権限を確認してください。" : access.reason === "preparing" ? "記事機能を準備中です。公開サイトの切替が完了するまで、下書きは作成されません。" : "現在、記事機能を利用できません。"}</p><Link href="/host">ホスト画面へ戻る</Link></main>;
  return (
    <main id="main" className="write-new-page">
      <Link href={experience ? `/write?experience=${encodeURIComponent(experience)}` : "/write"} className="write-back">← 記事一覧</Link>
      <header><p className="eyebrow">Write with NIHO.</p><h1>新しい記事</h1><p>このGET画面を開いただけでは記事は作られません。内容を確認して、明示的に下書きを作成します。</p></header>
      <NewGuideForm providers={access.context.ownerProviders} experience={experience} />
    </main>
  );
}
