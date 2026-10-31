"use client";

import { useEffect, useRef, useState } from "react";
import type { ExperienceProviderPageDetail } from "@niho-experience/api-client/host";
import { FieldSection, INPUT } from "./fields";
import { consoleButtonClass } from "./host-ui";
import { LIVE_PHOTO_LIMIT } from "./live-editor-state";

type PhotoAction = "earlier" | "later" | "cover" | "remove";

export interface LivePhotosSectionProps {
  photos: ExperienceProviderPageDetail["photos"];
  alts: readonly string[];
  onUpload: (file: File) => void;
  onAlt: (index: number, value: string) => void;
  onMove: (from: number, to: number) => void;
  onCover: (index: number) => void;
  onRemove: (index: number) => void;
}

/**
 * 写真 (#89): the first photo is the 表紙 the experience site shows first. Every photo has buttons for
 * 前へ / 後ろへ / 表紙にする / 外す (no dragging, so the keyboard and a phone work the same), and a
 * polite line says where it went. Focus stays on the photo that moved. Nothing is sent from here:
 * the order and the descriptions go with the page's one 保存.
 */
export function LivePhotosSection({ photos, alts, onUpload, onAlt, onMove, onCover, onRemove }: LivePhotosSectionProps) {
  const [note, setNote] = useState("");
  const list = useRef<HTMLUListElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const focusAfter = useRef<{ key: string | null; action: PhotoAction } | null>(null);
  const full = photos.length >= LIVE_PHOTO_LIMIT;
  // The buttons are in a new place after the move: focus the same one, or the first one still enabled in that photo's row.
  useEffect(() => {
    const target = focusAfter.current; focusAfter.current = null;
    if (!target) return;
    if (target.key === null) { fileInput.current?.focus(); return; }
    const row = [...(list.current?.children ?? [])].find((item) => item instanceof HTMLElement && item.dataset.photoKey === target.key);
    const buttons = row ? [...row.querySelectorAll<HTMLButtonElement>("button[data-photo-action]")] : [];
    (buttons.find((button) => button.dataset.photoAction === target.action && !button.disabled) ?? buttons.find((button) => !button.disabled))?.focus();
  }, [photos]);

  const act = (index: number, action: PhotoAction) => {
    const photo = photos[index]; if (!photo) return;
    // Removed: the next photo (or the one before it) takes the focus, the file picker when none is left.
    focusAfter.current = action === "remove" ? { key: (photos[index + 1] ?? photos[index - 1])?.objectKey ?? null, action } : { key: photo.objectKey, action };
    const place = (at: number) => `写真 ${index + 1} を ${at + 1} 番目にしました。`;
    if (action === "earlier") { onMove(index, index - 1); setNote(`${place(index - 1)}${index - 1 === 0 ? "表紙になります。" : ""}`); }
    else if (action === "later") { onMove(index, index + 1); setNote(place(index + 1)); }
    else if (action === "cover") { onCover(index); setNote(`写真 ${index + 1} を表紙にしました。`); }
    else { onRemove(index); setNote(`写真 ${index + 1} を外しました。保存すると反映されます。`); }
  };

  return <FieldSection title="写真">
    <p className="px-4 pt-1 pb-2 text-[0.8125rem] text-ink-soft">1 枚目が体験サイトの表紙です。並び順と説明は「保存」で反映されます。（{photos.length} / {LIVE_PHOTO_LIMIT} 枚）</p>
    <label className="block p-4 font-extrabold">写真を追加<input ref={fileInput} type="file" accept="image/jpeg,image/png,image/webp" disabled={full} className="mt-2 block w-full disabled:opacity-45" onChange={(event) => { const file = event.target.files?.[0]; if (file) onUpload(file); event.currentTarget.value = ""; }} />{full ? <span className="mt-1 block text-[0.8125rem] font-normal text-muted">写真は {LIVE_PHOTO_LIMIT} 枚までです。追加するには、どれかを外してください。</span> : null}</label>
    {photos.length === 0 ? <p className="border-t border-line p-4 text-[0.875rem] text-ink-soft">表紙の写真がありません。掲載を申請するには、写真を 1 枚以上追加して保存してください。</p> : null}
    <ul ref={list}>{photos.map((photo, index) => <li key={photo.objectKey} data-photo-key={photo.objectKey} className="grid grid-cols-[5rem_minmax(0,1fr)] gap-x-3 gap-y-2.5 border-t border-line p-4 sm:grid-cols-[6rem_minmax(0,1fr)]">
      <span className="relative block aspect-[4/3] self-start overflow-hidden rounded-xl bg-sand">
        {/* eslint-disable-next-line @next/next/no-img-element -- a signed storage URL or a blob: preview of the picked file */}
        {photo.url ? <img src={photo.url} alt="" className="size-full object-cover" /> : null}
        {index === 0 ? <span className="absolute top-1 left-1 rounded-full bg-leaf px-2 py-0.5 text-[0.6875rem] leading-tight font-extrabold text-ink">表紙</span> : null}
      </span>
      <label className="block min-w-0 self-start font-extrabold">写真 {index + 1} の説明{index === 0 ? "（表紙）" : ""}<input maxLength={200} className={`${INPUT} mt-1`} value={alts[index] ?? ""} onChange={(event) => onAlt(index, event.target.value)} /></label>
      <div role="group" aria-label={`写真 ${index + 1} の操作`} className="col-span-2 flex flex-wrap gap-1.5 sm:col-span-1 sm:col-start-2">
        <button type="button" data-photo-action="earlier" disabled={index === 0} aria-label={`写真 ${index + 1} を前へ`} className={consoleButtonClass("secondary", "sm", "disabled:opacity-45")} onClick={() => act(index, "earlier")}>前へ</button>
        <button type="button" data-photo-action="later" disabled={index === photos.length - 1} aria-label={`写真 ${index + 1} を後ろへ`} className={consoleButtonClass("secondary", "sm", "disabled:opacity-45")} onClick={() => act(index, "later")}>後ろへ</button>
        {index > 0 ? <button type="button" data-photo-action="cover" aria-label={`写真 ${index + 1} を表紙にする`} className={consoleButtonClass("secondary", "sm")} onClick={() => act(index, "cover")}>表紙にする</button> : null}
        <button type="button" data-photo-action="remove" aria-label={`写真 ${index + 1} を外す`} className={consoleButtonClass("ghost", "sm")} onClick={() => act(index, "remove")}>外す</button>
      </div>
    </li>)}</ul>
    <p role="status" aria-live="polite" className="sr-only">{note}</p>
  </FieldSection>;
}
