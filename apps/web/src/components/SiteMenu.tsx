"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { SiteNavigation } from "@/lib/site-nav";
import { buttonClass } from "./ui";
import { LocalizedLink } from "./LocalizedLink";
import { localeHref, useSiteLocale } from "./SiteLocale";

function MenuLink({ href, className, children }: { href: string; className: string; children: ReactNode }) {
  const { locale } = useSiteLocale();
  const target = localeHref(href, locale);
  const pathname = usePathname();
  const search = useSearchParams();
  const [path, query] = target.split("?");
  const category = new URLSearchParams(query).get("category");
  const current = pathname === path && search.get("category") === category;
  return <LocalizedLink href={href} aria-current={current ? "page" : undefined} className={`${className} ${current ? "text-moss" : ""}`}>{children}</LocalizedLink>;
}

/**
 * The header menu below md (#645). A `<details>`, so it opens and closes without JS; with JS it also closes when the page
 * changes, on Escape (focus returns to the button) and on a click outside. The panel hangs under the sticky header.
 */
export function SiteMenu({ navigation, language }: { navigation: SiteNavigation["mobile"]; language?: ReactNode }) {
  const { label, explore, visit, groups, hosts } = navigation;
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
    <div id="site-menu-panel" className="absolute inset-x-0 top-16 max-h-[calc(100dvh-4rem)] overflow-y-auto overscroll-contain border-b border-line bg-white shadow-[0_18px_30px_rgb(0_0_0/0.08)]">
      <nav
        aria-label={label}
        className="container-page divide-y divide-line py-2"
        onClick={(event) => { if (ref.current && event.target instanceof Element && event.target.closest("a")) ref.current.open = false; }}
      >
        <section className="py-4">
          <h2 className="font-sans text-sm font-bold">{explore.label}</h2>
          <ul className="mt-2 flex flex-wrap gap-2">
            {explore.links.map((link) => <li key={link.href}><MenuLink href={link.href} className="inline-flex min-h-9 items-center rounded-full border border-line-strong px-3 text-sm hover:bg-sand">{link.label}</MenuLink></li>)}
          </ul>
        </section>
        {[visit, ...(groups ? [groups] : [])].map((group) => <section key={group.label} className="py-3">
          <h2 className="font-sans text-sm font-bold">{group.label}</h2>
          <ul className="mt-1 grid grid-cols-2 gap-x-3">
            {group.links.map((link) => <li key={link.href}><MenuLink href={link.href} className="inline-flex min-h-10 items-center text-sm hover:underline">{link.label}</MenuLink></li>)}
          </ul>
        </section>)}
        <section className="py-4">
          <h2 className="font-sans text-sm font-bold">{hosts.label}</h2>
          <ul className="mt-2 flex flex-wrap gap-2">
            {hosts.links.map((link, index) => <li key={link.href}><MenuLink href={link.href} className={buttonClass(index === 0 ? "primary" : "secondary", "min-h-10 px-4 text-sm")}>{link.label}</MenuLink></li>)}
          </ul>
        </section>
        {language ? <section className="py-3 [&:not(:has(a))]:hidden">
          <h2 className="font-sans text-sm font-bold">{navigation.language}</h2>
          <div className="mt-1 flex min-h-8 items-center gap-3 text-sm">{language}</div>
        </section> : null}
      </nav>
    </div>
  </details>;
}
