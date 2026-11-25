import type { ReactNode } from "react";
import { RubberStamp } from "@niho/experience-presentation/v1";
import { HomeHeroSlides } from "../HomeHeroSlides";
import { PRESENTATION_PRIMITIVES_V1 } from "../PresentationV1";
import { HERO_PHOTO } from "@/lib/site-media";

const { Image } = PRESENTATION_PRIMITIVES_V1;

/**
 * 日本語トップのいちばん上の写真（#563、#658）。英語のトップと同じ組み：1枚目の写真に2枚を重ね、不透明度だけで入れ替える
 * （`.hero-fade-2` / `.hero-fade-3`。動きを減らす設定では1枚目のまま）。文字は写真の上に暗い覆いを重ねて読めるようにする。
 * 拡大や移動はしない。英語側の組みは `packages/experience-presentation` の `HomeViewV1`（`openHero`）。
 */
export function JapaneseHero({ children }: { children: ReactNode }) {
  return <section className="relative" aria-label="鎌倉の人に、会いにいく">
    <div className="relative h-[560px] overflow-hidden bg-[#222] lg:h-[680px]">
      <Image src={HERO_PHOTO.src} alt="" priority sizes="100vw" className="absolute inset-0 h-full w-full object-cover" style={{ objectPosition: HERO_PHOTO.position }} />
      <HomeHeroSlides />
      <div aria-hidden className="absolute inset-0 bg-[linear-gradient(180deg,rgb(0_0_0/0)_32%,rgb(0_0_0/0.64)_100%)] lg:bg-[linear-gradient(90deg,rgb(0_0_0/0.42),rgb(0_0_0/0)_62%),linear-gradient(180deg,rgb(0_0_0/0)_40%,rgb(0_0_0/0.5)_100%)]" />
      <div className="absolute inset-x-0 bottom-10 z-[2] text-white lg:bottom-14"><div className="container-page">{children}</div></div>
      <RubberStamp className="absolute top-[18px] right-4 z-[2] size-24 -rotate-12 text-white opacity-90 lg:top-11 lg:right-14 lg:size-[134px]" />
    </div>
  </section>;
}
