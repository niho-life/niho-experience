"use client";

import NextImage from "next/image";
import { useState } from "react";
import type { PublicVideo } from "@/lib/videos";

/** No YouTube iframe or request is made before the visitor presses play. */
export function YouTubeVideo({ video, poster, title }: { video: PublicVideo; poster: string; title: string }) {
  const [playing, setPlaying] = useState(false);
  return (
    <section aria-label={`Video: ${title}`}>
      <div className="relative aspect-video overflow-hidden rounded-[var(--radius-card)] bg-sand">
        {playing ? (
          <iframe
            className="absolute inset-0 h-full w-full"
            src={`https://www.youtube-nocookie.com/embed/${video.youtubeId}?autoplay=1`}
            title={`${title}: ${video.caption}`}
            loading="lazy"
            allow="autoplay; encrypted-media; picture-in-picture"
            allowFullScreen
            // YouTube requires the embedding site's origin as Referer; keep booking paths out of it.
            referrerPolicy="strict-origin-when-cross-origin"
          />
        ) : (
          <button type="button" onClick={() => setPlaying(true)} aria-label={`Play video: ${video.caption}`} className="group absolute inset-0 w-full cursor-pointer">
            <NextImage src={poster} alt="" fill unoptimized sizes="(min-width: 46rem) 736px, 100vw" className="object-cover" />
            <span aria-hidden className="absolute inset-0 bg-black/20 transition-colors group-hover:bg-black/30" />
            <span aria-hidden className="absolute top-1/2 left-1/2 grid size-16 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full bg-white text-moss shadow-lg transition-transform group-hover:scale-110">
              <svg viewBox="0 0 24 24" fill="currentColor" className="ml-1 size-7"><path d="M6 3.8a1 1 0 0 1 1.51-.86l12 8.2a1 1 0 0 1 0 1.72l-12 8.2A1 1 0 0 1 6 20.2Z" /></svg>
            </span>
          </button>
        )}
      </div>
      <p className="mt-2 text-sm text-ink-soft">Watch: {video.caption}</p>
    </section>
  );
}
