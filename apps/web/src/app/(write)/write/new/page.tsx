import type { Metadata } from "next";
import { loadWritePageAccess, writeExperienceQuery } from "@/lib/write/page-access";

export const metadata: Metadata = { title: "新しい記事" };
export default async function WriteNewPage({ searchParams }: { readonly searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const query = writeExperienceQuery(await searchParams);
  if (!query.ok) return <main id="main" className="mx-auto max-w-3xl px-4 py-12"><h1 className="text-2xl">新しい記事</h1><p className="mt-4">URL の体験指定が正しくありません。記事は作成されていません。</p></main>;
  const experience = query.experience;
  const returnPath = experience ? `/write/new?experience=${encodeURIComponent(experience)}` : "/write/new";
  const access = await loadWritePageAccess(returnPath);
  return (
    <main id="main" className="mx-auto max-w-3xl px-4 py-12">
      <h1 className="text-2xl">新しい記事</h1>
      <p className="mt-4">{access.ok ? "記事はまだ作成されていません。phase B の入力画面から明示的に作成します。" : access.reason === "forbidden" ? "記事を作成できる提供者 OWNER がありません。" : "現在利用できません。"}</p>
      {experience ? <p className="mt-2 text-sm text-muted">公開中の体験との関連付けは、作成 POST 時に同じ提供者であることを再確認します。</p> : null}
    </main>
  );
}
