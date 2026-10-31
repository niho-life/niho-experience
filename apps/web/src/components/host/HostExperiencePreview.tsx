"use client";

import NextImage from "next/image";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { DesktopGalleryViewV1, DetailViewV1, EN_STATIC_COPY_V1, MobileGalleryViewV1, PresentationRootV1, type DetailBookingCardModelV1, type DetailGalleryModelV1, type ImagePrimitiveProps, type LinkPrimitiveProps, type PresentationPrimitivesV1 } from "@niho/experience-presentation/v1";
import type { ExperienceProviderPagePreviewResponse } from "@niho-experience/api-client/host";
import { buildPreviewView, type PreviewBookingCard } from "@/lib/host/preview-model";
import { consoleButtonClass } from "./host-ui";

/*
 * 体験ページのプレビュー (#89): this site's experience detail (the traveler's `DetailViewV1`) for the page as NIHO saved it,
 * full screen in a dialog so the layout follows the phone or the desktop as the traveler's page does. Read through the BFF
 * (`…/preview`, private and no-store) every time it opens; nothing in it books, links out or is counted, and the editor
 * (with its unsaved changes) stays underneath. Loaded on demand: the host console does not carry the detail view otherwise.
 */

type PreviewState = { kind: "loading" } | { kind: "ready"; preview: ExperienceProviderPagePreviewResponse } | { kind: "missing" } | { kind: "error"; text: string };

/** A link that goes nowhere: the preview shows the page, it does not navigate (the look stays). The icon-only way back (it has an aria-label) is hidden from assistive technology, as it does nothing here. */
function PreviewLink({ children, className, "aria-label": ariaLabel }: LinkPrimitiveProps) {
  return <span className={className} aria-hidden={ariaLabel ? true : undefined}>{children}</span>;
}
function PreviewImage({ src, alt, className, sizes, priority, style, onError }: ImagePrimitiveProps) {
  return <NextImage src={src} alt={alt} fill unoptimized sizes={sizes} priority={priority} className={className} style={style} onError={onError} />;
}
const PREVIEW_PRIMITIVES: PresentationPrimitivesV1 = { Link: PreviewLink, Image: PreviewImage, Gallery: PreviewGallery };

/** Same behaviour as the traveler's gallery (swipe strip, the large view on desktop), minus its way back. */
function PreviewGallery({ model }: { model: DetailGalleryModelV1 }) {
  const [index, setIndex] = useState(0);
  const dialog = useRef<HTMLDialogElement>(null);
  const primitives = { Link: PreviewLink, Image: PreviewImage };
  return <><MobileGalleryViewV1 model={model} index={index} onPositionChange={setIndex} primitives={primitives} /><DesktopGalleryViewV1 model={model} dialogRef={dialog} onOpen={() => dialog.current?.showModal()} onClose={() => dialog.current?.close()} primitives={primitives} /></>;
}

function PreviewDates({ card }: { card: PreviewBookingCard }) {
  return <ul className="grid gap-2">{card.dates.map((row) => <li key={row.key} className="rounded-xl bg-sand px-3.5 py-2.5 text-[0.9375rem]"><b className="font-extrabold">{row.day}</b><span className="ml-2 text-ink-soft">{row.time}</span></li>)}</ul>;
}

export interface HostExperiencePreviewProps {
  /** `/host/api/provider-pages/{providerId}/{pageId}`. */
  endpoint: string;
  /** Changes not saved yet: the preview shows only what is saved. */
  unsaved: boolean;
  onClose: () => void;
}

export default function HostExperiencePreview({ endpoint, unsaved, onClose }: HostExperiencePreviewProps) {
  const baseId = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const [state, setState] = useState<PreviewState>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => { setState({ kind: "loading" }); setAttempt((value) => value + 1); }, []);

  useEffect(() => {
    const element = dialog.current;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    let cancelled = false;
    // A queued open keeps the StrictMode mount/unmount pass from racing showModal/close (as HostConfirmDialog does).
    queueMicrotask(() => { if (!cancelled && element?.isConnected && !element.open) { element.showModal(); close.current?.focus(); } });
    return () => { cancelled = true; if (previousFocus?.isConnected && (document.activeElement === document.body || element?.contains(document.activeElement))) previousFocus.focus(); };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(`${endpoint}/preview`, { cache: "no-store", signal: controller.signal });
        if (response.status === 404) { setState({ kind: "missing" }); return; }
        if (!response.ok) { setState({ kind: "error", text: response.status === 401 ? "ログインの有効期限が切れました。ホームから入り直してください。" : "プレビューを読み込めませんでした。" }); return; }
        const preview = await response.json() as ExperienceProviderPagePreviewResponse;
        if (!controller.signal.aborted) setState({ kind: "ready", preview });
      } catch { if (!controller.signal.aborted) setState({ kind: "error", text: "プレビューを読み込めませんでした。" }); }
    })();
    return () => controller.abort();
  }, [endpoint, attempt]);

  const view = useMemo(() => {
    if (state.kind !== "ready") return null;
    try { return buildPreviewView(state.preview); } catch { return null; }
  }, [state]);
  const booking = useMemo((): DetailBookingCardModelV1 | undefined => view ? {
    price: view.booking.price, priceIsFrom: view.booking.priceIsFrom, ...(view.booking.childNote ? { childNote: view.booking.childNote } : {}), ...(view.booking.schedule ? { schedule: view.booking.schedule } : {}),
    canBook: view.booking.canBook, bookingHref: "#preview", actionLabel: "Check dates and book", assurances: view.booking.assurances, dates: <PreviewDates card={view.booking} />,
  } : undefined, [view]);

  const failed = state.kind === "ready" && !view;
  return <dialog ref={dialog} aria-labelledby={`${baseId}-title`} onCancel={(event) => { event.preventDefault(); onClose(); }} onClose={onClose} data-testid="host-preview" className="m-0 h-dvh max-h-none w-screen max-w-none overflow-y-auto border-0 bg-white p-0 text-ink">
    <div className="sticky top-0 z-40 border-b border-line bg-canvas px-4 py-2 md:px-6">
      <div className="mx-auto max-w-5xl">
        <div className="flex items-center justify-between gap-3">
          <h2 id={`${baseId}-title`} className="min-w-0 font-sans text-[0.9375rem] font-extrabold tracking-normal">プレビュー<span className="ml-2 font-bold text-ink-soft">体験サイトの体験詳細</span></h2>
          <button ref={close} type="button" onClick={onClose} className={consoleButtonClass("secondary", "sm")}>閉じる</button>
        </div>
        <p role="status" className={`mt-1 text-[0.8125rem] ${unsaved ? "font-bold text-warn" : "text-ink-soft"}`}>{unsaved ? "未保存の変更があります。プレビューには保存した内容だけが出ます。保存すると反映されます。" : "保存した内容を表示しています。"}</p>
      </div>
    </div>
    <div className="mx-auto max-w-5xl px-4 pt-3 md:px-6">
      <ul className="list-disc space-y-0.5 pl-5 text-[0.8125rem] text-ink-soft">
        <li>予約・リンク・計測は動きません。体験サイトに載ると、この見た目になります。</li>
        <li>集合場所は予約が確定した方にだけ届くため、プレビューには出ません。</li>
        {view?.japanese ? <li>この体験ページは日本語です。体験サイトに載るのは英語のページだけです。英訳がある項目は英語で表示しています{view.fullyTranslated ? "。" : "（英訳が無い項目は日本語のままです）。"}</li> : null}
        {view && !view.booking.canBook ? <li>予約できる開催日がない、または受取口座の準備ができていないため、予約を受け付けていない表示になっています。</li> : null}
      </ul>
    </div>
    {state.kind === "loading" ? <p role="status" className="mx-auto max-w-5xl px-4 py-10 text-ink-soft md:px-6">読み込み中…</p> : null}
    {state.kind === "missing" ? <p role="alert" className="mx-auto max-w-5xl px-4 py-10 md:px-6">プレビューできる状態ではありません。有効な商品を 1 つ以上保存すると表示できます。</p> : null}
    {state.kind === "error" || failed ? <div role="alert" className="mx-auto flex max-w-5xl flex-wrap items-center gap-3 px-4 py-10 md:px-6"><p>{state.kind === "error" ? state.text : "プレビューを表示できませんでした。"}</p><button type="button" onClick={retry} className={consoleButtonClass("secondary", "sm")}>読み込み直す</button></div> : null}
    {view && booking ? <PresentationRootV1 className="pb-16"><DetailViewV1 model={{ ...view.model, booking }} primitives={PREVIEW_PRIMITIVES} copy={EN_STATIC_COPY_V1} /></PresentationRootV1> : null}
  </dialog>;
}
