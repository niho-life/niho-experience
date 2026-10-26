import Link from "next/link";
import type { ReactNode } from "react";
import type { GuideBlock, GuideInline } from "@/lib/guide-markdown";

/** Renders the parsed guide body (lib/guide-markdown.ts) as React elements. Text is always escaped by React: no HTML is injected. */
export function GuideBody({ blocks }: { blocks: readonly GuideBlock[] }) {
  return (
    <div className="text-[1.0625rem] leading-[1.75] [&>:first-child]:mt-0">
      {blocks.map((block, index) => {
        if (block.type === "heading") {
          return block.level === 2 ? (
            <h2 key={index} className="mt-11 text-[1.75rem] lg:text-[2rem]">
              <Inline items={block.children} />
            </h2>
          ) : (
            <h3 key={index} className="mt-8 font-sans text-[1.1875rem] leading-[1.4] font-extrabold tracking-normal">
              <Inline items={block.children} />
            </h3>
          );
        }
        if (block.type === "list") {
          return block.ordered ? (
            <ol key={index} className="mt-4 list-decimal space-y-2 pl-6 marker:font-extrabold marker:text-moss">
              {block.items.map((item, i) => (
                <li key={i} className="pl-1">
                  <Inline items={item} />
                </li>
              ))}
            </ol>
          ) : (
            <ul key={index} className="mt-4 space-y-2">
              {block.items.map((item, i) => (
                <li key={i} className="flex gap-3">
                  <span aria-hidden className="mt-[0.7em] size-[7px] shrink-0 rounded-full bg-leaf" />
                  <span>
                    <Inline items={item} />
                  </span>
                </li>
              ))}
            </ul>
          );
        }
        return (
          <p key={index} className="mt-4">
            <Inline items={block.children} />
          </p>
        );
      })}
    </div>
  );
}

function Inline({ items }: { items: readonly GuideInline[] }): ReactNode {
  return items.map((item, index) => {
    if (item.type === "text") return item.value;
    if (item.type === "strong") return <strong key={index} className="font-extrabold text-ink"><Inline items={item.children} /></strong>;
    if (item.type === "em") return <em key={index}><Inline items={item.children} /></em>;
    const className = "font-bold text-moss underline underline-offset-4";
    return item.external ? (
      <a key={index} href={item.href} rel="noopener noreferrer" className={className}>
        <Inline items={item.children} />
      </a>
    ) : (
      <Link key={index} href={item.href} className={className}>
        <Inline items={item.children} />
      </Link>
    );
  });
}
