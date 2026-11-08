import Link from "next/link";
import type { Metadata } from "next";
import { WriteList } from "@/components/write/WriteList";
import { config } from "@/lib/config";
import { loadWritePageAccess, writeExperienceQuery } from "@/lib/write/page-access";
import { privateGuideArticle } from "@/lib/write/server";

export const metadata: Metadata = { title: "記事" };

function State({ message }: { readonly message: string }) {
  return <main id="main" className="write-state"><h1>記事を書く</h1><p>{message}</p><Link href="/host">ホスト画面へ戻る</Link></main>;
}

export default async function WriteIndexPage({ searchParams }: { readonly searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const query = writeExperienceQuery(await searchParams);
  if (!query.ok) return <State message="URL の体験指定が正しくありません。" />;
  const returnPath = query.experience ? `/write?experience=${encodeURIComponent(query.experience)}` : "/write";
  const access = await loadWritePageAccess(returnPath);
  if (!access.ok) return <State message={access.reason === "forbidden" ? "記事を書ける提供者 OWNER がありません。ホスト画面で権限を確認してください。" : access.reason === "preparing" ? "記事機能を準備中です。公開サイトのデータ切替が完了するまで、保存や公開は受け付けません。" : "記事を読み込めません。時間をおいてお試しください。"} />;
  let guides: ReturnType<typeof privateGuideArticle>[] | null = null;
  let categories: Awaited<ReturnType<typeof access.context.repository.listActiveCategories>> = [];
  try {
    guides = (await access.context.repository.listArticles(access.context.actorId)).map(privateGuideArticle);
  } catch { return <State message="記事を読み込めません。時間をおいてお試しください。" />; }
  try { categories = await access.context.repository.listActiveCategories(); } catch { /* category labels are optional list chrome */ }
  return <WriteList chrome={{ account: access.context.account, providers: access.context.ownerProviders, nihoAppUrl: config.nihoWebOrigin, articles: guides ?? [] }} categories={categories} experience={query.experience} />;
}
