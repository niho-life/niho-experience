"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { PRESENTATION_PRIMITIVES_V1 } from "../PresentationV1";
import { HERO_ROTATE_MS, type HeroPhoto } from "@/lib/ja-home";

const { Image } = PRESENTATION_PRIMITIVES_V1;

/**
 * 日本語トップのいちばん上の写真（#563）：数枚を数秒ごとに入れ替え、点で切り替えられる。動きを減らす設定のときは自動では
 * 入れ替えず、点でだけ切り替える。タブが隠れている間は止める。文字は写真の上に暗い覆いを重ねて読めるようにする。
 */
export function JapaneseHero({ photos, children }: { photos: readonly HeroPhoto[]; children: ReactNode }) {
  const [index, setIndex] = useState(0);
  const [moving, setMoving] = useState(false);
  const paused = useRef(false);

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setMoving(!query.matches && photos.length > 1);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, [photos.length]);

  useEffect(() => {
    if (!moving) return;
    const timer = window.setInterval(() => {
      if (!paused.current && !document.hidden) setIndex((current) => (current + 1) % photos.length);
    }, HERO_ROTATE_MS);
    return () => window.clearInterval(timer);
  }, [moving, photos.length]);

  return <section
    aria-label="鎌倉の人に、会いにいく"
    className="relative isolate flex min-h-[26rem] items-end overflow-hidden bg-ink sm:min-h-[34rem]"
    onMouseEnter={() => { paused.current = true; }}
    onMouseLeave={() => { paused.current = false; }}
    onFocus={() => { paused.current = true; }}
    onBlur={() => { paused.current = false; }}
  >
    <div aria-hidden className="absolute inset-0 -z-10">
      {photos.map((photo, position) => <div key={photo.src} className={`absolute inset-0 transition-opacity duration-1000 motion-reduce:transition-none ${position === index ? "opacity-100" : "opacity-0"}`}>
        <Image src={photo.src} alt="" sizes="100vw" priority={position === 0} className="object-cover" style={{ objectPosition: photo.position }} />
      </div>)}
      <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-black/35 to-black/10" />
    </div>
    <div className="container-page w-full pt-24 pb-14 text-white sm:pb-20">{children}</div>
    {photos.length > 1 ? <div className="absolute right-4 bottom-4 flex gap-2 sm:right-8 sm:bottom-6" role="group" aria-label="写真の切り替え">
      {photos.map((photo, position) => <button
        key={photo.src}
        type="button"
        aria-label={`写真 ${position + 1}`}
        aria-current={position === index ? "true" : undefined}
        onClick={() => setIndex(position)}
        className="grid size-6 place-items-center"
      ><span className={`block size-2.5 rounded-full border border-white ${position === index ? "bg-white" : "bg-transparent"}`} /></button>)}
    </div> : null}
  </section>;
}
