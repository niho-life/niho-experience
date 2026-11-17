"use client";
import { ButtonLink, buttonClass } from "./ui";
import { LocalizedLink } from "./LocalizedLink";
import { useSiteCopy, useSiteLocale } from "./SiteLocale";

export function ErrorState({ title = "We couldn't load this page", message = "Please try again. If you already paid, use your confirmation email to check your booking.", onRetry }: { title?: string; message?: string; onRetry?: () => void }) {
  const copy = useSiteCopy();
  return <div role="alert" className="container-page max-w-2xl py-16 text-center"><p className="eyebrow">{copy.text("error.pageTitle")}</p><h1 className="mt-2 text-3xl">{title}</h1><p className="mt-4 text-ink-soft">{message}</p><div className="mt-8 flex flex-wrap justify-center gap-3">{onRetry ? <button type="button" onClick={onRetry} className={buttonClass("primary")}>{copy.text("common.tryAgain")}</button> : null}<LocalizedLink href="/experiences" className={buttonClass(onRetry ? "secondary" : "primary")}>{copy.text("catalogue.showAll")}</LocalizedLink></div><p className="mt-5"><LocalizedLink href="/help" className="font-bold text-moss underline">{copy.text("help.title")}</LocalizedLink></p></div>;
}

export function StagingUnavailableState() {
  const { locale } = useSiteLocale();
  const japanese = locale === "ja";
  return <div role="alert" className="container-page max-w-2xl py-16 text-center">
    <p className="eyebrow">{japanese ? "体験" : "Experiences"}</p>
    <h1 className="mt-2 text-3xl">{japanese ? "体験一覧を表示できません" : "The experience list is temporarily unavailable"}</h1>
    <p className="mt-4 text-ink-soft">{japanese ? "stg環境が休止中の可能性があります。stgを起動してから、このページを再読み込みしてください。" : "The staging environment may be asleep. Wake it, then reload this page."}</p>
    <div className="mt-8 flex justify-center"><button type="button" onClick={() => window.location.reload()} className={buttonClass("primary")}>{japanese ? "ページを再読み込み" : "Reload page"}</button></div>
  </div>;
}

export function EmptyResults({ clearHref, searchActive = false }: { clearHref: string | null; searchActive?: boolean }) {
  const copy = useSiteCopy();
  const { locale } = useSiteLocale();
  const title = copy.text(searchActive ? "catalogue.emptySearch" : clearHref ? "catalogue.emptyFilters" : "catalogue.empty");
  const message = copy.text(searchActive ? "catalogue.emptySearchBody" : "catalogue.emptyBody");
  const clearLabel = searchActive && locale === "en" ? "Clear search" : copy.text("catalogue.clearFilters");
  return <div className="rounded-[var(--radius-card)] border border-dashed border-line-strong bg-surface px-6 py-12 text-center"><h2 className="text-2xl">{title}</h2><p className="mx-auto mt-3 max-w-md text-ink-soft">{message}</p>{clearHref ? <div className="mt-6 flex justify-center"><ButtonLink href={clearHref}>{clearLabel}</ButtonLink></div> : null}</div>;
}
