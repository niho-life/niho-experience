import Link from "next/link";
import type { Metadata } from "next";
import { loadWritePageAccess, writeExperienceQuery } from "@/lib/write/page-access";
import { privateGuideArticle, writeApiError } from "@/lib/write/server";
import { writeStatusLabel } from "@/lib/write/client-types";

export const metadata: Metadata = { title: "記事" };

function State({ message }: { readonly message: string }) {
  return <main id="main" className="write-state"><h1>記事を書く</h1><p>{message}</p><Link href="/host">ホスト画面へ戻る</Link></main>;
}

export default async function WriteIndexPage({ searchParams }: { readonly searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const query = writeExperienceQuery(await searchParams);
  if (!query.ok) return <State message="URL の体験指定が正しくありません。" />;
  const returnPath = query.experience ? `/write?experience=${encodeURIComponent(query.experience)}` : "/write";
  const newPath = query.experience ? `/write/new?experience=${encodeURIComponent(query.experience)}` : "/write/new";
  const access = await loadWritePageAccess(returnPath);
  if (!access.ok) return <State message={access.reason === "forbidden" ? "記事を書ける提供者 OWNER がありません。ホスト画面で権限を確認してください。" : access.reason === "preparing" ? "記事機能を準備中です。公開サイトのデータ切替が完了するまで、保存や公開は受け付けません。" : "記事を読み込めません。時間をおいてお試しください。"} />;
  let guides: ReturnType<typeof privateGuideArticle>[] | null = null;
  let message: string | null = null;
  try {
    guides = (await access.context.repository.listArticles(access.context.actorId)).map(privateGuideArticle);
  } catch (error) {
    message = writeApiError(error).status === 404 ? "記事がありません。" : "記事を読み込めません。時間をおいてお試しください。";
  }
  if (!guides) return <State message={message ?? "記事を読み込めません。"} />;
  return (
    <main id="main" className="write-list-page">
      <header><div><p className="eyebrow">Write with NIHO.</p><h1>記事を書く</h1><p>地域の物語や体験の背景を、旅行者へ英語で届けます。</p></div><Link href={newPath} className="write-primary">新しい記事</Link></header>
      {guides.length ? <ul className="write-guide-list">
        {guides.map((guide) => <li key={guide.id}><Link href={`/write/${encodeURIComponent(guide.id)}`}><span><b>{guide.title || "無題の記事"}</b><small>更新 {new Date(guide.updatedAtUtc).toLocaleDateString("ja-JP")}</small></span><em>{writeStatusLabel(guide)}</em></Link></li>)}
      </ul> : <section className="write-empty"><h2>最初の記事を書きましょう</h2><p>タイトルから始め、本文と公開設定は下書きに自動保存できます。作成しただけでは公開されません。</p><Link href={newPath} className="write-primary">新しい記事を作る</Link></section>}
    </main>
  );
}
