import Link from "next/link";
import type { Metadata } from "next";
import { loadWritePageAccess, writeExperienceQuery } from "@/lib/write/page-access";
import { privateGuideArticle, writeApiError } from "@/lib/write/server";

export const metadata: Metadata = { title: "記事" };

function State({ message }: { readonly message: string }) {
  return <main id="main" className="mx-auto max-w-3xl px-4 py-12"><h1 className="text-2xl">記事を書く</h1><p className="mt-4">{message}</p></main>;
}

export default async function WriteIndexPage({ searchParams }: { readonly searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const query = writeExperienceQuery(await searchParams);
  if (!query.ok) return <State message="URL の体験指定が正しくありません。" />;
  const returnPath = query.experience ? `/write?experience=${encodeURIComponent(query.experience)}` : "/write";
  const newPath = query.experience ? `/write/new?experience=${encodeURIComponent(query.experience)}` : "/write/new";
  const access = await loadWritePageAccess(returnPath);
  if (!access.ok) return <State message={access.reason === "forbidden" ? "記事を管理できる提供者 OWNER がありません。" : "記事を読み込めません。時間をおいてお試しください。"} />;
  let guides: ReturnType<typeof privateGuideArticle>[] | null = null;
  let message: string | null = null;
  try {
    guides = (await access.context.repository.listArticles(access.context.actorId)).map(privateGuideArticle);
  } catch (error) {
    message = writeApiError(error).status === 404 ? "記事がありません。" : "記事を読み込めません。時間をおいてお試しください。";
  }
  if (!guides) return <State message={message ?? "記事を読み込めません。"} />;
  return (
    <main id="main" className="mx-auto max-w-3xl px-4 py-12">
      <header className="flex items-center justify-between gap-4"><h1 className="text-2xl">記事を書く</h1><Link href={newPath} className="font-bold underline">新しい記事</Link></header>
      <p className="mt-3 text-sm text-muted">編集画面は phase B で追加します。このページは認証済みの下書き境界を確認するための仮画面です。</p>
      <ul className="mt-8 grid gap-3">
        {guides.map((guide) => <li key={guide.id} className="rounded-xl border border-line p-4"><Link href={`/write/${encodeURIComponent(guide.id)}`} className="font-bold underline">{guide.title || "無題の記事"}</Link><span className="ml-2 text-sm text-muted">{guide.status}</span></li>)}
      </ul>
    </main>
  );
}
