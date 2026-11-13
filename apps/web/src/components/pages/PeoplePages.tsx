import Link from "next/link";
import type { PublicPerson } from "@niho-experience/experience-store";
import { Photo } from "@/components/Photo";
import { buttonClass } from "@/components/ui";
import { config } from "@/lib/config";
import type { SitePublicExperience } from "@/lib/experience/site-publications";
import { inquiryHref } from "@/lib/group-inquiry-entry";
import { japaneseTileFacts } from "@/lib/ja-experience-tile";

/** 街の人 (#564): everyone the office shows, with a way in for the person who is not here. Japanese site only. */
export function PeopleListPage({ people }: { people: readonly PublicPerson[] }) {
  return (
    <div className="mx-auto w-full max-w-[64rem] px-4 pb-16">
      <header className="py-10 sm:py-14">
        <p className="hand text-[1.25rem] text-moss">neighbors</p>
        <h1 className="mt-1 text-[2rem] leading-tight sm:text-[2.75rem]">街の人</h1>
        <p className="mt-4 max-w-[40rem] text-[1.0625rem] text-ink-soft">スタッフが会って、話を聞いて、体験を一緒につくっている人たちです。</p>
      </header>
      {people.length > 0 ? (
        <ul className="grid grid-cols-2 gap-x-4 gap-y-8 sm:grid-cols-3 lg:grid-cols-4">
          {people.map((person) => (
            <li key={person.slug}>
              <Link href={`/ja/people/${person.slug}`} className="group block">
                <Photo image={{ url: person.photo.src, alt: person.photo.altJa }} alt={person.photo.altJa} sizes="(min-width: 1024px) 220px, (min-width: 640px) 30vw, 45vw" aspect="aspect-[4/5]" rounded="rounded-[18px]" />
                <span className="mt-3 block text-[1.0625rem] font-extrabold group-hover:underline">{person.name}</span>
                <span className="block text-[0.9375rem]">{person.roleJa}</span>
                <small className="block text-ink-soft">{person.areaJa}</small>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <p className="rounded-[18px] bg-sand px-5 py-8 text-center text-ink-soft">いま紹介できる人を準備しています。</p>
      )}
      {config.groupInquiryEnabled ? (
        <section aria-labelledby="people-ask" className="mt-14 rounded-[22px] bg-leaf-pale px-6 py-8 sm:px-10">
          <h2 id="people-ask" className="text-[1.5rem]">会いたい人が、ここにいないときは</h2>
          <p className="mt-2 text-ink-soft">載せていない人も、事務局が知っていることがあります。目的を聞かせてください。はじめの相談は無料です。</p>
          <a href={inquiryHref("ja")} className={buttonClass("primary", "mt-5 w-full sm:w-auto")}>相談する</a>
        </section>
      ) : null}
    </div>
  );
}

/** One person: who they are, a way to talk to them through the office, and the experiences they offer. */
export function PersonPage({ person, experiences }: { person: PublicPerson; experiences: readonly SitePublicExperience[] }) {
  return (
    <div className="mx-auto w-full max-w-[64rem] px-4 pb-16">
      <nav aria-label="パンくずリスト" className="pt-6 text-sm text-muted">
        <Link href="/ja/people" className="font-extrabold text-ink hover:underline">街の人</Link>
        <span aria-hidden> / </span>
        <span aria-current="page">{person.name}</span>
      </nav>
      <header className="mt-6 grid gap-8 md:grid-cols-[minmax(0,18rem)_1fr] md:items-start">
        <Photo image={{ url: person.photo.src, alt: person.photo.altJa }} alt={person.photo.altJa} sizes="(min-width: 768px) 288px, 90vw" priority aspect="aspect-[4/5]" rounded="rounded-[22px]" />
        <div>
          <p className="hand text-[1.25rem] text-moss">{person.name}</p>
          <h1 className="mt-1 text-[1.75rem] leading-tight sm:text-[2.25rem]">{person.name}</h1>
          <p className="mt-2 text-ink-soft">{person.roleJa}・{person.areaJa}</p>
          {person.quoteJa ? <p className="mt-5 text-[1.25rem] leading-snug">「{person.quoteJa}」</p> : null}
          {person.introJa ? <p className="mt-4 max-w-[40rem] whitespace-pre-line text-ink-soft">{person.introJa}</p> : null}
          {person.photo.credit ? <p className="mt-3 text-xs text-muted">写真：{person.photo.credit}</p> : null}
          {config.groupInquiryEnabled ? (
            <a href={inquiryHref("ja", { from: "PROVIDER", hostName: person.name })} className={buttonClass("secondary", "mt-6 w-full sm:w-auto")}>{person.name}さんに相談する</a>
          ) : null}
        </div>
      </header>
      {experiences.length > 0 ? (
        <section aria-labelledby="person-experiences" className="mt-14">
          <p className="hand text-[1.25rem] text-moss">spend time with</p>
          <h2 id="person-experiences" className="text-[1.5rem]">{person.name}さんと過ごす</h2>
          <ul className="mt-5 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {experiences.map((item) => <ExperienceTile key={item.publication.slug} item={item} />)}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

function ExperienceTile({ item }: { item: SitePublicExperience }) {
  const tile = japaneseTileFacts(item);
  return (
    <li>
      <Link href={`/ja/experiences/${tile.slug}`} className="group block">
        <Photo image={tile.cover} alt={tile.cover?.alt ?? ""} sizes="(min-width: 1024px) 320px, (min-width: 640px) 45vw, 90vw" aspect="aspect-[4/3]" rounded="rounded-[18px]" />
        <span className="mt-3 block text-[1.0625rem] font-extrabold group-hover:underline">{tile.title}</span>
        <small className="block text-ink-soft">{[tile.duration, tile.price].filter(Boolean).join("・")}</small>
      </Link>
    </li>
  );
}
