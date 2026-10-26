import NextImage from "next/image";
import Link from "next/link";
import type { ReactNode } from "react";
import type { GuideBlock, GuideInline } from "@/lib/guide-markdown";

/** Renders the parsed guide body (lib/guide-markdown.ts) as React elements. Text is always escaped by React: no HTML is injected. */
export function GuideBody({ blocks }: { blocks: readonly GuideBlock[] }) {
  return (
    <div className="text-[1.0625rem] leading-[1.75] [&>:first-child]:mt-0">
      <Blocks blocks={blocks} />
    </div>
  );
}

function Blocks({ blocks }: { blocks: readonly GuideBlock[] }): ReactNode {
  return blocks.map((block, index) => <Block key={index} block={block} />);
}

function Block({ block }: { block: GuideBlock }) {
  switch (block.type) {
    case "heading":
      return block.level === 2 ? (
        <h2 className="mt-11 text-[1.75rem] lg:text-[2rem]">
          <GuideInlines items={block.children} />
        </h2>
      ) : (
        <h3 className="mt-8 font-sans text-[1.1875rem] leading-[1.4] font-extrabold tracking-normal">
          <GuideInlines items={block.children} />
        </h3>
      );
    case "list":
      return block.ordered ? (
        <ol className="mt-4 list-decimal space-y-2 pl-6 marker:font-extrabold marker:text-moss">
          {block.items.map((item, i) => (
            <li key={i} className="pl-1">
              <GuideInlines items={item} />
            </li>
          ))}
        </ol>
      ) : (
        <ul className="mt-4 space-y-2">
          {block.items.map((item, i) => (
            <li key={i} className="flex gap-3">
              <span aria-hidden className="mt-[0.7em] size-[7px] shrink-0 rounded-full bg-leaf" />
              <span className="min-w-0">
                <GuideInlines items={item} />
              </span>
            </li>
          ))}
        </ul>
      );
    case "figure":
      // A fixed 3:2 frame (no layout shift whatever the photo's size), rounded like the hero.
      return (
        <figure className="mt-8">
          <div className="relative aspect-[3/2] overflow-hidden rounded-[var(--radius-card)] bg-sand">
            <NextImage src={block.src} alt={block.alt} fill unoptimized sizes="(min-width: 46rem) 736px, 100vw" className="object-cover" />
          </div>
          {block.caption ? (
            <figcaption className="mt-2 text-sm leading-normal text-muted">
              <GuideInlines items={block.caption} />
            </figcaption>
          ) : null}
        </figure>
      );
    case "table":
      // Only the box scrolls sideways on narrow screens; it takes keyboard focus so the hidden columns stay reachable.
      return (
        <div role="region" aria-label={block.label} tabIndex={0} className="mt-6 max-w-full overflow-x-auto rounded-2xl border border-line">
          <table className="w-full border-collapse text-left text-[0.9375rem] leading-snug" style={{ minWidth: `${block.head.length * 8}rem` }}>
            <thead className="bg-sand">
              <tr>
                {block.head.map((cell, i) =>
                  // An empty top-left corner is a plain cell, not an empty column header.
                  cell.length ? (
                    <th key={i} scope="col" className="border-b border-line px-3.5 py-2.5 align-bottom font-extrabold">
                      <GuideInlines items={cell} />
                    </th>
                  ) : (
                    <td key={i} className="border-b border-line" />
                  ),
                )}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, rowIndex) => (
                <tr key={rowIndex} className="border-b border-line last:border-b-0">
                  {row.map((cell, i) =>
                    i === 0 ? (
                      <th key={i} scope="row" className="px-3.5 py-2.5 align-top font-bold">
                        <GuideInlines items={cell} />
                      </th>
                    ) : (
                      <td key={i} className="px-3.5 py-2.5 align-top text-ink-soft">
                        <GuideInlines items={cell} />
                      </td>
                    ),
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "note":
      return (
        <aside role="note" className="mt-6 rounded-[var(--radius-card)] bg-sand px-5 py-4 text-[0.96875rem] text-ink-soft sm:px-6 [&>:first-child]:mt-0">
          <Blocks blocks={block.blocks} />
        </aside>
      );
    case "paragraph":
      return (
        <p className="mt-4">
          <GuideInlines items={block.children} />
        </p>
      );
  }
}

/** Inline content of the body, a caption or a FAQ answer. */
export function GuideInlines({ items }: { items: readonly GuideInline[] }): ReactNode {
  return items.map((item, index) => {
    if (item.type === "text") return item.value;
    if (item.type === "strong") return <strong key={index} className="font-extrabold text-ink"><GuideInlines items={item.children} /></strong>;
    if (item.type === "em") return <em key={index}><GuideInlines items={item.children} /></em>;
    // A fact still to check: only drafts and samples reach the page with one (published guides fail guidePublishProblems).
    if (item.type === "confirm") {
      return (
        <mark key={index} className="rounded-md bg-warn-pale px-1.5 py-0.5 font-bold text-warn [box-decoration-break:clone]">
          To confirm: {item.value}
        </mark>
      );
    }
    const className = "font-bold text-moss underline underline-offset-4";
    return item.external ? (
      <a key={index} href={item.href} rel="noopener noreferrer" className={className}>
        <GuideInlines items={item.children} />
      </a>
    ) : (
      <Link key={index} href={item.href} className={className}>
        <GuideInlines items={item.children} />
      </Link>
    );
  });
}
