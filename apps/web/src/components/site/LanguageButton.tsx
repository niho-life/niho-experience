"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { languageButtonTarget } from "@/lib/locale-links";

/**
 * 言語を切り替えるボタン（#562）。日本語のページでは「EN」、英語のページでは「日本語」。同じページの相手の言語へ移り、
 * 相手が無いページではその言語のトップへ移る。日本語だけの体験のページでは出さない。ヘッダーには `pill`、フッターには `text`。
 */
export function LanguageButton({ counterparts, variant = "pill" }: { counterparts: Readonly<Record<string, string>>; variant?: "pill" | "text" }) {
  const pathname = usePathname();
  const search = useSearchParams().toString();
  const target = languageButtonTarget(pathname, search, counterparts);
  if (!target) return null;
  const toEnglish = pathname === "/ja" || pathname.startsWith("/ja/");
  const label = toEnglish ? (variant === "pill" ? "EN" : "English") : "日本語";
  return <Link
    href={target}
    hrefLang={toEnglish ? "en" : "ja"}
    lang={toEnglish ? "en" : "ja"}
    aria-label={toEnglish ? "English" : "日本語"}
    className={variant === "pill"
      ? "inline-flex min-h-9 shrink-0 items-center rounded-full border border-line-strong px-2.5 py-1 text-[0.8125rem] font-extrabold whitespace-nowrap hover:bg-sand"
      : "hover:underline"}
  >{label}</Link>;
}
