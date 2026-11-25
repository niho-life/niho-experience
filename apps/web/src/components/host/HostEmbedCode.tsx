"use client";

import { useEffect, useRef, useState } from "react";
import { bookButtonSnippet, embedBookSnippet, embedBookUrl } from "@/host/embed-snippet";
import { EMBED_RESIZE_MESSAGE } from "@/lib/experience/embed-frame";
import { consoleButtonClass } from "./host-ui";
import { EditorPanel } from "./editor-parts";

/*
 * 自分のサイトに貼る (#638, docs/embed.md「ホストの画面」): the kind (widget or button), the real widget as a preview, the code to
 * copy and how to paste it. Nothing is issued or stored; the code is the public page's address and is not secret.
 */

type Kind = "widget" | "button";
type Format = "code" | "url";

const PRESSABLE = "grid min-w-0 content-start gap-1 rounded-[14px] border border-line-strong bg-white p-3.5 text-left aria-pressed:border-ink aria-pressed:bg-leaf-pale aria-pressed:ring-1 aria-pressed:ring-ink";
const SEGMENT = "h-8 rounded-full px-3 text-xs font-extrabold text-ink-soft aria-pressed:bg-white aria-pressed:text-ink";

const HOW_TO: readonly { readonly service: string; readonly steps: readonly string[] }[] = [
  { service: "STUDIO", steps: ["追加パネルから「Embed」を置きます。", "コードを貼り付けます。", "高さを「auto」にして、サイトを更新します。"] },
  { service: "WordPress", steps: ["ページの編集で「カスタム HTML」ブロックを追加します。", "コードを貼り付けます。", "ページを更新します。"] },
  { service: "Wix", steps: ["「埋め込み」から「HTML を埋め込む」を置きます。", "コードを貼り付けます。", "枠の大きさを整えて、公開します。"] },
];

export function HostEmbedCode({ siteOrigin, slug, title }: { siteOrigin: string; slug: string; title: string }) {
  const [kind, setKind] = useState<Kind>("widget");
  const [format, setFormat] = useState<Format>("code");
  const [copyState, setCopyState] = useState<{ tone: "ok" | "alert"; text: string } | null>(null);
  const [previewHeight, setPreviewHeight] = useState(760);
  const preview = useRef<HTMLIFrameElement>(null);

  // The preview is this site's own widget: take its height, and only from that frame.
  useEffect(() => {
    function onMessage(event: MessageEvent) {
      if (event.origin !== window.location.origin || !preview.current || event.source !== preview.current.contentWindow) return;
      const data: unknown = event.data;
      if (typeof data !== "object" || data === null || (data as { type?: unknown }).type !== EMBED_RESIZE_MESSAGE) return;
      const height = (data as { height?: unknown }).height;
      if (typeof height === "number" && Number.isFinite(height)) setPreviewHeight(Math.max(240, Math.ceil(height)));
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  const snippet = kind === "button"
    ? bookButtonSnippet({ siteOrigin, slug })
    : format === "url" ? embedBookUrl(siteOrigin, slug) : embedBookSnippet({ siteOrigin, slug, title });
  const note = kind === "button"
    ? "リンクとして貼れます。ボタンの見た目は自由に変えられます。"
    : format === "url" ? "URL だけを受け付ける埋め込み枠に使います。高さは枠の設定で決まります。" : "高さは中身に合わせて自動で変わります。";

  function choose(next: Kind) {
    setKind(next);
    setCopyState(null);
  }

  async function copy() {
    if (!snippet) return;
    setCopyState(null);
    try {
      await navigator.clipboard.writeText(snippet);
      setCopyState({ tone: "ok", text: "コピーしました。" });
    } catch {
      // The clipboard may be refused (an in-app browser, a permission): the code above can be selected by hand.
      setCopyState({ tone: "alert", text: "自動でコピーできませんでした。上のコードを選んでコピーしてください。" });
    }
  }

  return (
    <div className="grid min-w-0 gap-3.5">
      <EditorPanel id="embed-kind" title="種類">
        <div className="grid gap-2.5 md:grid-cols-2">
          <button type="button" aria-pressed={kind === "widget"} onClick={() => choose("widget")} className={PRESSABLE}>
            <b className="text-[0.9375rem] font-extrabold">予約ウィジェット<span className="ml-1.5 inline-block rounded-full bg-moss px-2 align-[1px] text-[0.6875rem] font-extrabold text-white">おすすめ</span></b>
            <small className="text-[0.8125rem] leading-normal text-ink-soft">カレンダーから日程を選び、そのまま決済へ進めます。</small>
          </button>
          <button type="button" aria-pressed={kind === "button"} onClick={() => choose("button")} className={PRESSABLE}>
            <b className="text-[0.9375rem] font-extrabold">予約ボタン</b>
            <small className="text-[0.8125rem] leading-normal text-ink-soft">ボタンを押すと、体験サイトの予約ページが開きます。</small>
          </button>
        </div>
      </EditorPanel>

      <EditorPanel id="embed-preview" title="プレビュー">
        <div className="min-w-0 rounded-xl bg-sand p-4">
          {kind === "widget"
            ? <iframe ref={preview} src={`/embed/experiences/${encodeURIComponent(slug)}/book?preview=1`} title="予約ウィジェットのプレビュー" style={{ height: previewHeight }} className="mx-auto block w-full max-w-[520px] border-0" />
            : <div className="py-5 text-center"><span className="inline-flex min-h-12 items-center justify-center rounded-full bg-ink px-7 font-extrabold text-white">Book now</span></div>}
        </div>
        <p className="mt-2 text-xs leading-normal text-muted">実際の表示です。プレビューでは予約できません。</p>
      </EditorPanel>

      <EditorPanel id="embed-code" title="コード" actions={<button type="button" disabled={!snippet} onClick={() => void copy()} className={consoleButtonClass("primary", "sm")}>コードをコピー</button>}>
        {kind === "widget" ? <div role="group" aria-label="形式" className="mb-3 inline-flex rounded-full bg-sand p-0.5">
          <button type="button" aria-pressed={format === "code"} onClick={() => { setFormat("code"); setCopyState(null); }} className={SEGMENT}>コード</button>
          <button type="button" aria-pressed={format === "url"} onClick={() => { setFormat("url"); setCopyState(null); }} className={SEGMENT}>URL だけ</button>
        </div> : null}
        <pre aria-label="貼り付けるコード" className="max-h-72 min-w-0 overflow-auto rounded-xl bg-ink p-3.5 font-mono text-[0.78125rem] leading-normal break-all whitespace-pre-wrap text-white">{snippet ?? ""}</pre>
        <p className="mt-2 text-xs leading-normal text-muted">{note}</p>
        {copyState ? <p role={copyState.tone === "alert" ? "alert" : "status"} className={`mt-1 text-[0.78125rem] leading-normal font-bold ${copyState.tone === "alert" ? "text-danger" : "text-moss"}`}>{copyState.text}</p> : null}
      </EditorPanel>

      <EditorPanel id="embed-how" title="貼り方">
        {HOW_TO.map((item) => (
          <details key={item.service} className="border-t border-line first-of-type:border-t-0">
            <summary className="min-h-10 cursor-pointer py-2.5 text-sm font-extrabold">{item.service}</summary>
            <ol className="mb-3 grid list-decimal gap-1 pl-5 text-sm text-ink-soft">
              {item.steps.map((step) => <li key={step}>{step}</li>)}
            </ol>
          </details>
        ))}
      </EditorPanel>

      <p className="text-xs leading-normal text-muted">公開ページと同じく、コードと URL は誰でも見られるものです。</p>
    </div>
  );
}
