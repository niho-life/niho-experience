import type { TitledText } from "@/lib/ja-service-copy";
import { USAGE_PAGE } from "@/lib/ja-service-copy";

function Column({ id, title, items }: { id: string; title: string; items: readonly TitledText[] }) {
  return (
    <section aria-labelledby={id}>
      <h2 id={id} className="text-[1.5rem]">{title}</h2>
      <ul className="mt-5 grid gap-5">
        {items.map((item) => (
          <li key={item.title} className="flex gap-3">
            <span aria-hidden className="mt-1 grid size-6 shrink-0 place-items-center rounded-full bg-leaf-pale text-sm font-extrabold text-moss">✓</span>
            <span><b className="block">{item.title}</b><span className="text-ink-soft">{item.body}</span></span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** ご利用の案内 (#565): short, for people taking part and for people offering. No promise that covers every experience (#538). */
export function UsagePage() {
  return (
    <div className="mx-auto w-full max-w-[64rem] px-4 pb-16">
      <header className="py-10 sm:py-14">
        <p className="hand text-[1.25rem] text-moss">{USAGE_PAGE.eyebrow}</p>
        <h1 className="mt-1 text-[2rem] leading-tight sm:text-[2.75rem]">{USAGE_PAGE.title}</h1>
        <p className="mt-4 text-[1.0625rem] text-ink-soft">{USAGE_PAGE.sub}</p>
      </header>
      <div className="grid gap-12 py-6 md:grid-cols-2">
        <Column id="usage-guests" title={USAGE_PAGE.guestsTitle} items={USAGE_PAGE.guests} />
        <Column id="usage-hosts" title={USAGE_PAGE.hostsTitle} items={USAGE_PAGE.hosts} />
      </div>
    </div>
  );
}
