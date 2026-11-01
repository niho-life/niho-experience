"use client";

import { useEffect, useRef, useState } from "react";
import type { ExperienceProviderPageDetail } from "@niho-experience/api-client/host";
import { EditorPanel } from "./editor-parts";
import { HostConfirmDialog } from "./HostConfirmDialog";
import { consoleButtonClass } from "./host-ui";
import { HostIcon } from "./HostIcon";

type PageLanguage = ExperienceProviderPageDetail["language"];

const LANGUAGES: { value: PageLanguage; label: string; lang: string }[] = [
  { value: "JA", label: "日本語", lang: "ja" },
  { value: "EN", label: "English", lang: "en" },
];

const KV = "grid grid-cols-[64px_minmax(0,1fr)] items-center gap-2 border-t border-line py-[9px] text-[0.8125rem] first:border-t-0 first:pt-0.5";
const KV_KEY = "text-xs font-extrabold text-muted";

const SWITCH_TEXT: Record<PageLanguage, { title: string; description: string; confirm: string }> = {
  EN: { title: "英語で書く形に切り替えますか？", description: "本文は今のまま残ります。日本語で書いてある項目は、英語に書き直してください。保存すると反映されます。", confirm: "英語で書く" },
  JA: { title: "日本語で書く形に切り替えますか？", description: "本文は今のまま残ります。日本語のページは体験サイトに載せられず、英語は NIHO の自動訳（読むだけ）になります。保存すると反映されます。", confirm: "日本語で書く" },
};

export interface LivePagePanelProps {
  language: PageLanguage;
  onLanguage: (language: PageLanguage) => void;
  /** The page's address on the experience site, once it is listed. */
  publicUrl: string | null;
  disabled: boolean;
}

/**
 * ページ (mock v2 `.rail`, NIHO 接続版): the language the page is written in (書く言語, #110) and, once it is listed, its public
 * address. A page has one language. Switching asks first and keeps the words as they are: NIHO does not translate them into
 * the other language, and an English of a Japanese page is NIHO's own, to read only (live-english.ts).
 */
export function LivePagePanel({ language, onLanguage, publicUrl, disabled }: LivePagePanelProps) {
  const [copied, setCopied] = useState<"done" | "failed" | null>(null);
  const [asking, setAsking] = useState<PageLanguage | null>(null);
  const stay = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(null), 2500);
    return () => window.clearTimeout(timer);
  }, [copied]);
  const copy = async () => {
    if (!publicUrl) return;
    try { await navigator.clipboard.writeText(publicUrl); setCopied("done"); } catch { setCopied("failed"); }
  };
  const text = asking ? SWITCH_TEXT[asking] : null;
  return (
    <EditorPanel id="editor-page" title="ページ">
      <div>
        <div className={KV}>
          <span id="editor-language-label" className={KV_KEY}>書く言語</span>
          <span role="radiogroup" aria-labelledby="editor-language-label" className="inline-flex w-fit rounded-full bg-sand p-0.5">
            {LANGUAGES.map((option) => (
              <label
                key={option.value}
                lang={option.lang}
                className="relative block h-8 rounded-full px-3 text-xs leading-8 font-extrabold text-ink-soft has-[:checked]:bg-canvas has-[:checked]:text-ink has-[:checked]:shadow-[0_1px_2px_rgb(0_0_0/0.08)] has-[:focus-visible]:outline-3 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-moss"
              >
                <input type="radio" name="editor-language" value={option.value} checked={language === option.value} disabled={disabled} onChange={() => { if (option.value !== language) setAsking(option.value); }} className="absolute inset-0 z-[1] size-full cursor-pointer appearance-none rounded-full opacity-0 focus-visible:outline-none disabled:cursor-default" />
                {option.label}
              </label>
            ))}
          </span>
        </div>
        {publicUrl ? (
          <div className={KV}>
            <span className={KV_KEY}>URL</span>
            <span className="flex min-w-0 items-center gap-1">
              <span className="min-w-0 text-xs [overflow-wrap:anywhere]">{publicUrl.replace(/^https?:\/\//, "")}</span>
              <button type="button" aria-label="URL をコピー" onClick={copy} className="grid size-7 shrink-0 place-items-center rounded-md text-muted hover:bg-sand hover:text-ink">
                <HostIcon name="copy" className="size-3.5" />
              </button>
            </span>
          </div>
        ) : null}
      </div>
      <p className="mt-1 text-xs leading-normal text-muted">{language === "JA" ? "日本語で書くと、英語は NIHO が自動で作ります（読むだけ）。体験サイトに載せられるのは、英語で書いたページです。" : "体験サイトには、書いた英語がそのまま出ます。"}</p>
      <p role="status" className="text-xs font-bold text-moss">{copied === "done" ? "URL をコピーしました" : copied === "failed" ? "コピーできませんでした" : ""}</p>
      {asking && text ? (
        <HostConfirmDialog
          title={text.title}
          description={text.description}
          focusRef={stay}
          stayRef={stay}
          confirm={<button type="submit" className={consoleButtonClass("primary")}>{text.confirm}</button>}
          onConfirm={() => onLanguage(asking)}
          onClose={() => setAsking(null)}
        />
      ) : null}
    </EditorPanel>
  );
}
