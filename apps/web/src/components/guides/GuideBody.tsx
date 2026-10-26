import Link from "next/link";
import type { ReactNode } from "react";
import { ExperienceCard } from "@/components/ExperienceCard";
import { Photo } from "@/components/Photo";
import type { CardModel } from "@/lib/card-model";
import type { Block, Inline } from "@/lib/guides/types";

/**
 * Renders a guide's parsed body (lib/guides/markdown.ts) as React elements. Manuscript text is only ever
 * a text node or an attribute value React escapes: there is no HTML injection path.
 */

export const GUIDE_LINK_CLASS = "font-bold text-moss underline decoration-leaf decoration-2 underline-offset-4 hover:decoration-moss";

export function GuideInlines({ nodes }: { nodes: Inline[] }): ReactNode {
  return nodes.map((node, index) => {
    switch (node.type) {
      case "text":
        return node.text;
      case "strong":
        return <strong key={index} className="font-extrabold text-ink"><GuideInlines nodes={node.children} /></strong>;
      case "em":
        return <em key={index}><GuideInlines nodes={node.children} /></em>;
      case "confirm":
        return <Confirm key={index} text={node.text} />;
      case "link":
        return node.href.startsWith("/") ? (
          <Link key={index} href={node.href} className={GUIDE_LINK_CLASS}><GuideInlines nodes={node.children} /></Link>
        ) : (
          <a key={index} href={node.href} className={GUIDE_LINK_CLASS} {...(node.href.startsWith("https:") ? { rel: "noopener noreferrer" } : {})}>
            <GuideInlines nodes={node.children} />
          </a>
        );
    }
  });
}

/** `[CONFIRM: …]`: a fact still to check. Only drafts reach the page with one (published files fail validation). */
function Confirm({ text }: { text: string }) {
  return <mark className="rounded-md bg-warn-pale px-1.5 py-0.5 font-bold text-warn [box-decoration-break:clone]">To confirm: {text}</mark>;
}

export function GuideBlocks({ blocks, cards }: { blocks: Block[]; cards: ReadonlyMap<string, CardModel> }) {
  return blocks.map((block, index) => <GuideBlock key={index} block={block} cards={cards} />);
}

function GuideBlock({ block, cards }: { block: Block; cards: ReadonlyMap<string, CardModel> }) {
  switch (block.type) {
    case "h2":
      return <h2 id={block.id} className="scroll-mt-24 pt-12 text-[1.75rem] lg:text-[2rem]"><GuideInlines nodes={block.children} /></h2>;
    case "h3":
      return <h3 className="pt-7 text-[1.375rem]"><GuideInlines nodes={block.children} /></h3>;
    case "paragraph":
      return <p className="mt-4"><GuideInlines nodes={block.children} /></p>;
    case "ul":
      return (
        <ul className="mt-4 space-y-2.5">
          {block.items.map((item, index) => (
            <li key={index} className="flex gap-3">
              <span aria-hidden className="mt-[0.6em] size-[7px] shrink-0 rounded-full bg-leaf" />
              <span className="min-w-0"><GuideInlines nodes={item} /></span>
            </li>
          ))}
        </ul>
      );
    case "ol":
      return (
        <ol className="mt-4 list-decimal space-y-2.5 pl-6 marker:font-extrabold marker:text-moss">
          {block.items.map((item, index) => <li key={index} className="pl-1"><GuideInlines nodes={item} /></li>)}
        </ol>
      );
    case "quote":
      return (
        <figure className="my-8 border-l-4 border-leaf pl-5">
          <blockquote className="space-y-3 font-display text-[1.3125rem] leading-snug">
            {block.paragraphs.map((paragraph, index) => <p key={index}><GuideInlines nodes={paragraph} /></p>)}
          </blockquote>
          {block.cite ? <figcaption className="hand mt-3 text-[1.5rem]">— <GuideInlines nodes={block.cite} /></figcaption> : null}
        </figure>
      );
    case "figure":
      return (
        <figure className="my-8">
          <Photo image={{ url: block.src }} alt={block.alt} aspect="aspect-[3/2]" sizes="(min-width: 48rem) 736px, 100vw" />
          {block.caption ? <figcaption className="mt-2 text-sm text-muted"><GuideInlines nodes={block.caption} /></figcaption> : null}
        </figure>
      );
    case "experience": {
      const card = cards.get(block.slug);
      return card ? <div className="my-8 max-w-[22rem]"><ExperienceCard card={card} /></div> : null;
    }
    case "note":
      return (
        <div role="note" className="my-8 rounded-[var(--radius-card)] bg-sand px-5 pt-1 pb-5 text-[0.96875rem] text-ink-soft sm:px-6">
          <GuideBlocks blocks={block.blocks} cards={cards} />
        </div>
      );
    case "faq":
      return (
        <section aria-labelledby="faq" className="pt-2">
          <h2 id="faq" className="scroll-mt-24 pt-12 text-[1.75rem] lg:text-[2rem]">Questions people ask</h2>
          <div className="mt-2 divide-y divide-line">
            {block.items.map((item, index) => (
              <div key={index} className="py-5">
                <h3 className="font-sans text-[1.0625rem] leading-snug font-extrabold tracking-normal"><GuideInlines nodes={item.questionInlines} /></h3>
                <div className="text-ink-soft [&>*:first-child]:mt-2"><GuideBlocks blocks={item.answer} cards={cards} /></div>
              </div>
            ))}
          </div>
        </section>
      );
    case "table":
      return (
        <div role="region" aria-label={block.label} tabIndex={0} className="my-6 max-w-full overflow-x-auto rounded-2xl border border-line">
          {/* About 7.5rem a column: narrow screens scroll the box sideways instead of squeezing the words. */}
          <table className="w-full border-collapse text-left text-[0.9375rem] leading-snug" style={{ minWidth: `${block.head.length * 7.5}rem` }}>
            <thead className="bg-sand">
              <tr>
                {block.head.map((cell, index) => (
                  <th key={index} scope="col" className="border-b border-line px-3.5 py-2.5 align-bottom font-extrabold">
                    <GuideInlines nodes={cell} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, rowIndex) => (
                <tr key={rowIndex} className="border-b border-line last:border-b-0">
                  {row.map((cell, index) =>
                    index === 0 ? (
                      <th key={index} scope="row" className="px-3.5 py-2.5 align-top font-bold"><GuideInlines nodes={cell} /></th>
                    ) : (
                      <td key={index} className="px-3.5 py-2.5 align-top text-ink-soft"><GuideInlines nodes={cell} /></td>
                    ),
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
  }
}
