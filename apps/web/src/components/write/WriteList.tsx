/* eslint-disable @next/next/no-img-element -- private authenticated cover thumbnails */
"use client";

import Link from "next/link";
import { useMemo, useRef, useState } from "react";
import { hasSavedChangesSincePublication, writeStatusLabel, type WriteCategory, type WriteGuide } from "@/lib/write/client-types";
import { WriteNewGuideDialog, type WriteNewGuideDialogHandle } from "./WriteNewGuideDialog";
import { WriteWorkspace, type WriteChromeProps } from "./WriteWorkspace";

type Filter = "ALL" | "DRAFT" | "PUBLISHED" | "STOPPED";
const FILTERS: readonly { value: Filter; label: string }[] = [
  { value: "ALL", label: "すべて" },
  { value: "DRAFT", label: "下書き" },
  { value: "PUBLISHED", label: "公開中" },
  { value: "STOPPED", label: "公開停止中" },
];

function matchesFilter(guide: WriteGuide, filter: Filter) {
  if (filter === "ALL") return true;
  if (filter === "STOPPED") return guide.status === "STOPPED" || guide.status === "OPS_STOPPED";
  return guide.status === filter;
}

export function WriteList({ chrome, categories, experience, autoOpenNew = false, editPath = "/write" }: {
  readonly chrome: WriteChromeProps;
  readonly categories: readonly WriteCategory[];
  readonly experience: string | null;
  readonly autoOpenNew?: boolean;
  readonly editPath?: string;
}) {
  const [filter, setFilter] = useState<Filter>("ALL");
  const [query, setQuery] = useState("");
  const newGuideDialog = useRef<WriteNewGuideDialogHandle>(null);
  const categoryLabels = useMemo(() => new Map(categories.map((category) => [category.slug, category.labelJa])), [categories]);
  const normalized = query.trim().toLocaleLowerCase("ja");
  const visible = chrome.articles.filter((guide) => matchesFilter(guide, filter) && (!normalized || guide.title.toLocaleLowerCase("ja").includes(normalized) || guide.slug.includes(normalized)));
  const returnPath = experience ? `/write?experience=${encodeURIComponent(experience)}` : "/write";
  return <WriteWorkspace chrome={chrome} writePath={returnPath} onNewArticle={(event) => newGuideDialog.current?.open(event.currentTarget)}>
    <main id="main" className="write-list-page">
      <header className="write-page-head"><div><h1>記事</h1><p>鎌倉の暮らしや体験の背景を、英語で旅行者へ届けます。</p></div><WriteNewGuideDialog ref={newGuideDialog} providers={chrome.providers} experience={experience} autoOpen={autoOpenNew} returnPath={returnPath} editPath={editPath} /></header>
      {chrome.articles.length ? <>
        <div className="write-list-tools">
          <div className="write-filter-chips" role="group" aria-label="状態で絞り込む">
            {FILTERS.map((item) => {
              const count = chrome.articles.filter((guide) => matchesFilter(guide, item.value)).length;
              return <button key={item.value} type="button" aria-pressed={filter === item.value} onClick={() => setFilter(item.value)}>{item.label}<span>{count}</span></button>;
            })}
          </div>
          <label className="write-list-search"><span className="sr-only">題名・URLで検索</span><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="題名・URLで検索" /></label>
        </div>
        <p className="write-list-count" role="status">{visible.length}件</p>
        {visible.length ? <ul className="write-guide-list">
          {visible.map((guide) => <li key={guide.id}><Link href={`/write/${encodeURIComponent(guide.id)}${experience ? `?experience=${encodeURIComponent(experience)}` : ""}`}>
            <span className="write-list-thumb">{guide.cover ? <img src={`/write/api/guides/${encodeURIComponent(guide.id)}/media/${encodeURIComponent(guide.cover.assetId)}`} alt="" /> : <span aria-hidden="true">記事</span>}</span>
            <span className="write-list-copy"><b>{guide.title || "無題の記事"}</b><small>{[guide.categorySlug ? categoryLabels.get(guide.categorySlug) ?? "カテゴリ未設定" : "カテゴリ未設定", `更新 ${new Date(guide.updatedAtUtc).toLocaleDateString("ja-JP", { timeZone: "Asia/Tokyo" })}`, guide.draftProductLinks.length ? `関連体験 ${guide.draftProductLinks.length}` : null].filter(Boolean).join(" · ")}</small>{guide.status === "PUBLISHED" ? <small className="write-list-url">/guides/{guide.slug}</small> : null}</span>
            <span className="write-list-pills"><em>{writeStatusLabel(guide)}</em>{hasSavedChangesSincePublication(guide) ? <em className="write-list-change">未公開の変更</em> : null}</span>
          </Link></li>)}
        </ul> : <section className="write-no-results" role="status"><h2>条件に合う記事はありません</h2><p>検索語または状態の絞り込みを変えてください。</p></section>}
        <p className="write-list-note">作成しただけでは公開されません。公開・停止は記事ごとに行います。</p>
      </> : <section className="write-empty"><h2>最初の記事を書きましょう</h2><p>題名だけで下書きを作れます。公開するまで旅行者には見えません。</p><ol><li><b>1</b>下書きを作る</li><li><b>2</b>英語で本文を書く</li><li><b>3</b>公開前チェック</li><li><b>4</b>公開</li></ol></section>}
    </main>
  </WriteWorkspace>;
}
