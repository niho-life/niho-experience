import type { Metadata } from "next";
import Link from "next/link";
import { WriteList } from "@/components/write/WriteList";
import { config } from "@/lib/config";
import { loadWritePageAccess, writeExperienceQuery } from "@/lib/write/page-access";
import { privateGuideArticle } from "@/lib/write/server";

export const metadata: Metadata = { title: "新しい記事" };
export default async function WriteNewPage({ searchParams }: { readonly searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const query = writeExperienceQuery(await searchParams);
  if (!query.ok) return <main id="main" className="mx-auto max-w-3xl px-4 py-12"><h1 className="text-2xl">新しい記事</h1><p className="mt-4">URL の体験指定が正しくありません。記事は作成されていません。</p></main>;
  const experience = query.experience;
  const returnPath = experience ? `/write/new?experience=${encodeURIComponent(experience)}` : "/write/new";
  const access = await loadWritePageAccess(returnPath);
  if (!access.ok) return <main id="main" className="write-state"><h1>新しい記事</h1><p>{access.reason === "forbidden" ? "記事を書ける提供者 OWNER がありません。ホスト画面で権限を確認してください。" : access.reason === "preparing" ? "記事機能を準備中です。公開サイトの切替が完了するまで、下書きは作成されません。" : "現在、記事機能を利用できません。"}</p><Link href="/host">ホスト画面へ戻る</Link></main>;
  let articles: ReturnType<typeof privateGuideArticle>[] = [];
  let categories: Awaited<ReturnType<typeof access.context.repository.listActiveCategories>> = [];
  try { articles = (await access.context.repository.listArticles(access.context.actorId)).map(privateGuideArticle); }
  catch { return <main id="main" className="write-state"><h1>新しい記事</h1><p>記事一覧を確認できないため、誤った状態で作成を続けられません。時間をおいてお試しください。</p><Link href={experience ? `/write?experience=${encodeURIComponent(experience)}` : "/write"}>記事一覧へ戻る</Link></main>; }
  try { categories = await access.context.repository.listActiveCategories(); } catch { /* category labels are optional list chrome */ }
  return <WriteList chrome={{ account: access.context.account, providers: access.context.ownerProviders, nihoAppUrl: config.nihoWebOrigin, articles }} categories={categories} experience={experience} autoOpenNew />;
}
