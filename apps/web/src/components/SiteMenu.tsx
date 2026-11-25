"use client";

import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { LocalizedLink } from "./LocalizedLink";
import { localeHref, useSiteLocale } from "./SiteLocale";

const ROW = "flex min-h-[3.25rem] items-center border-b border-line text-[1.0625rem] font-extrabold";

function MenuLink({ href, className, children }: { href: string; className: string; children: ReactNode }) {
  const { locale } = useSiteLocale();
  const current = usePathname() === localeHref(href, locale);
  return <LocalizedLink href={href} aria-current={current ? "page" : undefined} className={`${className} ${current ? "text-moss" : ""}`}>{children}</LocalizedLink>;
}

/**
 * The header menu below md (#645). A `<details>`, so it opens and closes without JS; with JS it also closes when the page
 * changes, on Escape (focus returns to the button) and on a click outside. The panel hangs under the sticky header.
 */
export type SiteMenuItem = Readonly<{ href: string; label: string }>;

/** `items` are the rows, then `language` (a row that hides itself when empty), then `foot` (the quiet last row). `label` names the button and the nav. */
export function SiteMenu({ items, foot, language, label = "Menu" }: { items: readonly SiteMenuItem[]; foot?: SiteMenuItem | null; language?: ReactNode; label?: string }) {
  const pathname = usePathname();
  const ref = useRef<HTMLDetailsElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => { if (ref.current) ref.current.open = false; }, [pathname]);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !node.open) return;
      node.open = false;
      node.querySelector("summary")?.focus();
    };
    const onPointer = (event: PointerEvent) => { if (node.open && event.target instanceof Node && !node.contains(event.target)) node.open = false; };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    return () => { document.removeEventListener("keydown", onKey); document.removeEventListener("pointerdown", onPointer); };
  }, []);

  return <details ref={ref} className="md:hidden" onToggle={(event) => setMenuOpen(event.currentTarget.open)}>
    <summary role="button" aria-label={label} aria-expanded={menuOpen} aria-controls="site-menu-panel" className="grid size-10 cursor-pointer list-none place-items-center rounded-full border border-line-strong hover:bg-sand [&::-webkit-details-marker]:hidden">
      <svg className="ico size-5" viewBox="0 0 24 24" aria-hidden><path d="M4.5 8h15M4.5 12.5h15M4.5 17h15" /></svg>
    </summary>
    <div id="site-menu-panel" className="absolute inset-x-0 top-16 border-b border-line bg-white shadow-[0_18px_30px_rgb(0_0_0/0.08)]">
      <div className="container-page pb-4 pt-1">
        <nav aria-label={label}>
          {/* A link to the page already open changes no pathname, so close on the click itself too. */}
          <ul onClick={(event) => { if (ref.current && event.target instanceof Element && event.target.closest("a")) ref.current.open = false; }}>
            {items.map((item) => <li key={item.href}><MenuLink href={item.href} className={ROW}>{item.label}</MenuLink></li>)}
            {language ? <li className={`${ROW} empty:hidden [&>a]:flex [&>a]:min-h-[3.25rem] [&>a]:w-full [&>a]:items-center`}>{language}</li> : null}
            {foot ? <li><MenuLink href={foot.href} className="flex min-h-[3.25rem] items-center text-[0.9375rem] font-bold text-ink-soft">{foot.label}</MenuLink></li> : null}
          </ul>
        </nav>
      </div>
    </div>
  </details>;
}
