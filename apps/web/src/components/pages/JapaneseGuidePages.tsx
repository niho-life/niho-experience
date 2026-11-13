import NextImage from "next/image";
import Link from "next/link";
import { GuideBody } from "@/components/GuideBody";
import { Photo } from "@/components/Photo";
import { buttonClass } from "@/components/ui";
import type { Guide } from "@/content/guides";
import { config } from "@/lib/config";
import type { SitePublicExperience } from "@/lib/experience/site-publications";
import { guideOutline } from "@/lib/guides";
import { guideLinkHref, parseGuideMarkdown } from "@/lib/guide-markdown";
import { inquiryHref } from "@/lib/group-inquiry-entry";
import { japaneseTileFacts } from "@/lib/ja-experience-tile";
import { formatJapaneseDate } from "@/lib/ja-guides";

/** 読みもの (#154):歩き方、時間の使い方、雨の日のこと。 Japanese site only; every article here was written in Japanese in /write. */
export function JapaneseGuidesListPage({ guides }: { guides: readonly Guide[] }) {
  return (
    <div className="mx-auto w-full max-w-[64rem] px-4 pb-16">
      <header className="py-10 sm:py-14">
        <p className="hand text-[1.25rem] text-moss">field notes</p>
        <h1 className="mt-1 text-[2rem] leading-tight sm:text-[2.75rem]">読みもの</h1>
        <p className="mt-4 max-w-[40rem] text-[1.0625rem] text-ink-soft">歩き方、時間の使い方、雨の日のこと。街の人に聞いて書いています。</p>
      </header>
      {guides.length > 0 ? (
        <ul className="grid gap-x-5 gap-y-9 sm:grid-cols-2 lg:grid-cols-3">
          {guides.map((guide) => (
            <li key={guide.slug}>
              <Link href={`/ja/guides/${guide.slug}`} className="group block">
                <Photo image={guide.hero ? { url: guideLinkHref(guide.hero.src)?.href ?? guide.hero.src, alt: guide.hero.alt } : null} alt={guide.hero?.alt ?? ""} sizes="(min-width: 1024px) 320px, (min-width: 640px) 45vw, 90vw" aspect="aspect-[3/2]" rounded="rounded-[18px]" />
                {guide.category ? <span className="mt-3 block text-[0.8125rem] font-extrabold text-moss">{guide.category.labelJa ?? guide.category.label}</span> : null}
                <span className="mt-1 block text-[1.125rem] font-extrabold leading-snug group-hover:underline">{guide.title}</span>
                {guide.description ? <span className="mt-1 block text-[0.9375rem] text-ink-soft">{guide.description}</span> : null}
                <small className="mt-2 block text-muted">{guide.author.name}・{formatJapaneseDate(guide.publishedAt)}</small>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <p className="rounded-[18px] bg-sand px-5 py-8 text-center text-ink-soft">読みものを準備しています。</p>
      )}
    </div>
  );
}

/** One 読みもの article: title, who wrote it and when, the cover, the body, and a way on to the experiences and the office. */
export function JapaneseGuideArticlePage({ guide, experiences }: { guide: Guide; experiences: readonly SitePublicExperience[] }) {
  const blocks = parseGuideMarkdown(guide.body);
  const outline = guideOutline(blocks);
  const toc = outline.filter((item) => item.level === 2);
  const hero = guide.hero ? { ...guide.hero, href: guideLinkHref(guide.hero.src)?.href ?? null } : null;
  const figures = new Map(guide.publicFigures?.map((figure) => [figure.assetId.toLowerCase(), figure]) ?? []);
  const categoryLabel = guide.category?.labelJa ?? guide.category?.label ?? null;
  return (
    <article className="mx-auto w-full max-w-[64rem] px-4 pb-16 pt-6 sm:pt-9">
      <div className="mx-auto max-w-[46rem]">
        <nav aria-label="パンくずリスト" className="text-sm text-muted">
          <Link href="/ja/guides" className="font-extrabold text-ink hover:underline">読みもの</Link>
          {categoryLabel ? <><span aria-hidden> / </span><span aria-current="page">{categoryLabel}</span></> : null}
        </nav>
        <header className="pt-5">
          <h1 className="text-[1.875rem] leading-[1.2] sm:text-[2.5rem]">{guide.title}</h1>
          {guide.description ? <p className="mt-4 text-[1.125rem] leading-relaxed text-ink-soft">{guide.description}</p> : null}
          <p className="mt-4 text-[0.9375rem] text-muted">
            <b className="font-extrabold text-ink">{guide.author.name}</b>{guide.author.role ? `（${guide.author.role}）` : ""}・公開 <time dateTime={guide.publishedAt}>{formatJapaneseDate(guide.publishedAt)}</time>
            {guide.updatedAt !== guide.publishedAt ? <>・更新 <time dateTime={guide.updatedAt}>{formatJapaneseDate(guide.updatedAt)}</time></> : null}
          </p>
        </header>
        {hero?.href ? (
          <figure className="mt-7">
            <NextImage src={hero.href} alt={hero.alt} width={hero.width} height={hero.height} priority unoptimized sizes="(min-width: 46rem) 736px, 100vw" className="h-auto w-full rounded-[18px]" />
            {hero.caption ? <figcaption className="mt-2 text-sm text-muted">{hero.caption}</figcaption> : null}
          </figure>
        ) : null}
        {toc.length > 1 ? (
          <nav aria-labelledby="ja-guide-toc" className="mt-7 rounded-[18px] border border-line bg-sand px-5 py-4 sm:px-6">
            <h2 id="ja-guide-toc" className="font-sans text-sm font-extrabold tracking-normal">この記事の内容</h2>
            <ol className="mt-2 grid gap-1.5 text-sm text-ink-soft">
              {toc.map((item) => <li key={item.id}><a href={`#${item.id}`} className="hover:text-ink hover:underline">{item.sectionNumber}. {item.title}</a></li>)}
            </ol>
          </nav>
        ) : null}
        <div className="pt-8">
          <GuideBody
            blocks={blocks}
            outline={outline}
            figureSrc={(figure) => figure.assetId ? figures.get(figure.assetId.toLowerCase())?.src ?? null : null}
            figureCredit={(assetId) => figures.get(assetId.toLowerCase())?.credit}
          />
        </div>
        {experiences.length > 0 ? (
          <section aria-labelledby="ja-guide-experiences" className="pt-12">
            <p className="hand text-[1.25rem] text-moss">go with someone</p>
            <h2 id="ja-guide-experiences" className="text-[1.5rem]">この記事に出てくる体験</h2>
            <ul className="mt-5 grid gap-5 sm:grid-cols-2">
              {experiences.map((item) => <ExperienceTile key={item.publication.slug} item={item} />)}
            </ul>
          </section>
        ) : null}
        {config.groupInquiryEnabled ? (
          <section aria-labelledby="ja-guide-ask" className="mt-12 rounded-[22px] bg-leaf-pale px-6 py-8">
            <h2 id="ja-guide-ask" className="text-[1.375rem]">この記事のことで、相談したいときは</h2>
            <p className="mt-2 text-ink-soft">体験を選び切れなくても、日にちが決まっていなくても大丈夫です。はじめの相談は無料です。</p>
            <a href={inquiryHref("ja")} className={buttonClass("primary", "mt-5 w-full sm:w-auto")}>相談する</a>
          </section>
        ) : null}
        <section aria-labelledby="ja-guide-author" className="mt-12 border-t border-line pt-6">
          <h2 id="ja-guide-author" className="font-sans text-base font-extrabold tracking-normal">この記事を書いた人</h2>
          <p className="mt-2 text-[0.9375rem] leading-relaxed text-ink-soft">
            <b className="font-extrabold text-ink">{guide.author.name}</b>
            {(guide.author.bio ?? guide.author.role) ? <>・{guide.author.bio ?? guide.author.role}</> : null}
          </p>
        </section>
      </div>
    </article>
  );
}

function ExperienceTile({ item }: { item: SitePublicExperience }) {
  const tile = japaneseTileFacts(item);
  return (
    <li>
      <Link href={`/ja/experiences/${tile.slug}`} className="group block">
        <Photo image={tile.cover} alt={tile.cover?.alt ?? ""} sizes="(min-width: 640px) 45vw, 90vw" aspect="aspect-[4/3]" rounded="rounded-[18px]" />
        <span className="mt-3 block text-[1.0625rem] font-extrabold group-hover:underline">{tile.title}</span>
        <small className="block text-ink-soft">{[tile.duration, tile.price].filter(Boolean).join("・")}</small>
      </Link>
    </li>
  );
}
