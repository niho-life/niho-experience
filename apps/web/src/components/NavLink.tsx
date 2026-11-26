"use client";

import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { LocalizedLink } from "./LocalizedLink";
import { localeHref, useSiteLocale } from "./SiteLocale";

/** Header link that marks the page it leads to (a pale surface and aria-current). */
export function NavLink({ href, className = "", prefetch, children }: { href: string; className?: string; prefetch?: boolean; children: ReactNode }) {
  const { locale } = useSiteLocale();
  const target = localeHref(href, locale);
  const current = usePathname() === target;
  return (
    <LocalizedLink href={href} prefetch={prefetch} aria-current={current ? "page" : undefined} className={`${className} ${current ? "bg-sand" : ""}`}>
      {children}
    </LocalizedLink>
  );
}
