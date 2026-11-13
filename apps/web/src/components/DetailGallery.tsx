"use client";

import { useRef, useState } from "react";
import { DesktopGalleryViewV1, MobileGalleryViewV1, type DetailGalleryModelV1 } from "@niho/experience-presentation/v1";
import type { PublicImageForSite } from "@/lib/experience-types";
import { imageAlt } from "@/lib/experience-copy";
import { PRESENTATION_PRIMITIVES_V1 } from "./PresentationV1";
import { useSiteLocale } from "./SiteLocale";

function galleryModel(photos: PublicImageForSite[], title: string, backHref = "/experiences", ja = false): DetailGalleryModelV1 {
  return {
    title,
    backHref,
    photos: photos.map((photo, index) => {
      const alt = imageAlt(photo, index === 0 ? title : ja ? `${title}、写真 ${index + 1} / ${photos.length}` : `${title}, photo ${index + 1} of ${photos.length}`);
      return { image: { src: photo.url, alt }, alt };
    }),
  };
}

/** The public controller owns gallery state; the frozen presentation package owns the markup. */
export function MobileGallery({ photos, title, backHref = "/experiences" }: { photos: PublicImageForSite[]; title: string; backHref?: string }) {
  const [index, setIndex] = useState(0);
  // The page's language: the gallery's own words (all photos, previous, next) follow it instead of the view's English default.
  const { copy, locale } = useSiteLocale();
  return <MobileGalleryViewV1 model={galleryModel(photos, title, backHref, locale === "ja")} index={index} onPositionChange={setIndex} primitives={PRESENTATION_PRIMITIVES_V1} copy={copy} />;
}

/** Public controller owns dialog effects; v1 owns the mosaic, trigger and dialog. */
export function DesktopGallery({ photos, title }: { photos: PublicImageForSite[]; title: string }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const { copy, locale } = useSiteLocale();
  return <DesktopGalleryViewV1 model={galleryModel(photos, title, "/experiences", locale === "ja")} dialogRef={dialog} onOpen={() => dialog.current?.showModal()} onClose={() => dialog.current?.close()} primitives={PRESENTATION_PRIMITIVES_V1} copy={copy} />;
}
