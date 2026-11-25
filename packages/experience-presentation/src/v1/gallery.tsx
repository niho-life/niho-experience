"use client";

import { useId, useRef, useState, type ComponentType, type Ref } from "react";
import { HandIcon, PhotoV1 } from "./components.js";
import { EN_STATIC_COPY_V1, type StaticCopyAccessorV1 } from "./static-copy.js";
import { primitivesV1, type DetailGalleryModelV1, type ImagePrimitiveProps, type PresentationPrimitivesV1 } from "./types.js";

export function MobileGalleryViewV1({ model, index = 0, onPositionChange, onPhotoClick, primitives, copy = EN_STATIC_COPY_V1 }: { model: DetailGalleryModelV1; index?: number; onPositionChange?: (index: number) => void; onPhotoClick?: () => void; primitives?: Partial<PresentationPrimitivesV1>; copy?: StaticCopyAccessorV1 }) {
  const { Link, Image } = primitivesV1(primitives);
  const count = model.photos.length;
  const canOpenPhotos = count > 1 && Boolean(onPhotoClick);
  const galleryId = useId();
  const track = useRef<HTMLDivElement>(null);
  const [localIndex, setLocalIndex] = useState(index);
  const currentIndex = onPositionChange ? index : localIndex;
  const setPosition = (next: number) => {
    if (!count) return;
    const position = Math.max(0, Math.min(count - 1, next));
    setLocalIndex(position);
    onPositionChange?.(position);
  };
  const showPhoto = (next: number) => {
    if (!count) return;
    const position = Math.max(0, Math.min(count - 1, next));
    const element = track.current;
    element?.scrollTo({ left: position * (element.clientWidth || 1), behavior: "instant" });
    setPosition(position);
  };
  return <div className="relative lg:hidden">
    <div
      ref={track}
      id={galleryId}
      tabIndex={0}
      role="region"
      aria-roledescription="carousel"
      aria-label={copy.text("detail.photosOf", { title: model.title })}
      aria-describedby={count > 1 ? `${galleryId}-help` : undefined}
      onKeyDown={(event) => {
        const next = event.key === "ArrowRight" ? currentIndex + 1 : event.key === "ArrowLeft" ? currentIndex - 1 : event.key === "Home" ? 0 : event.key === "End" ? count - 1 : null;
        if (next !== null) { event.preventDefault(); showPhoto(next); }
      }}
      onScroll={(event) => {
        const element = event.currentTarget;
        setPosition(Math.round(element.scrollLeft / Math.max(1, element.clientWidth)));
      }}
      className="scrollbar-none flex snap-x snap-mandatory overflow-x-auto"
    >
      {count ? model.photos.map((photo, photoIndex) => <div key={`${photo.image.src}-${photoIndex}`} className="relative aspect-square w-full shrink-0 snap-start bg-sand sm:aspect-[16/10]">{canOpenPhotos
        ? <button type="button" aria-haspopup="dialog" aria-label={`${copy.text("detail.allPhotos")}: ${photo.alt}`} onClick={onPhotoClick} className="absolute inset-0 block w-full cursor-zoom-in border-0 bg-transparent p-0 text-left focus-visible:z-[1] focus-visible:ring-4 focus-visible:ring-inset focus-visible:ring-ink"><GalleryPhotoV1 Image={Image} photo={photo} priority={photoIndex === 0} copy={copy} /></button>
        : <GalleryPhotoV1 Image={Image} photo={photo} priority={photoIndex === 0} copy={copy} />}</div>)
        : <div role="img" aria-label={copy.text("detail.photosUnavailable", { title: model.title })} className="aspect-[16/10] w-full bg-sand" />}
    </div>
    {count > 1 ? <p id={`${galleryId}-help`} className="sr-only">{copy.text("detail.galleryKeyboardHelp")}</p> : null}
    <Link href={model.backHref} aria-label={copy.text("chrome.allExperiences")} className="absolute top-3.5 left-3.5 grid size-11 place-items-center rounded-full bg-white/95 shadow-[0_2px_8px_rgb(0_0_0/0.15)]"><HandIcon name="back" className="size-5 [stroke-width:2.2]" /></Link>
    {count > 1 ? <div className="absolute right-3.5 bottom-3.5 flex items-center gap-1 rounded-full bg-ink/85 p-1 text-[0.8125rem] font-extrabold text-white">
      <button type="button" aria-label={copy.text("detail.previousPhoto")} aria-controls={galleryId} disabled={currentIndex === 0} onClick={() => showPhoto(currentIndex - 1)} className="grid size-11 place-items-center rounded-full hover:bg-white/20 disabled:opacity-40"><HandIcon name="back" className="size-5" /></button>
      <span role="status" aria-atomic="true" className="min-w-12 text-center"><span className="sr-only">{copy.text("detail.photoPosition", { title: model.title, position: currentIndex + 1, count })}</span><span aria-hidden>{currentIndex + 1} / {count}</span></span>
      <button type="button" aria-label={copy.text("detail.nextPhoto")} aria-controls={galleryId} disabled={currentIndex === count - 1} onClick={() => showPhoto(currentIndex + 1)} className="grid size-11 place-items-center rounded-full hover:bg-white/20 disabled:opacity-40"><HandIcon name="back" className="size-5 rotate-180" /></button>
    </div> : null}
  </div>;
}

function GalleryPhotoV1({ Image, photo, priority, copy }: { Image: ComponentType<ImagePrimitiveProps>; photo: DetailGalleryModelV1["photos"][number]; priority: boolean; copy: StaticCopyAccessorV1 }) {
  const [failed, setFailed] = useState(false);
  return failed
    ? <span role="img" aria-label={photo.alt} className="absolute inset-0 flex items-center justify-center text-sm text-muted">{copy.text("detail.photoUnavailable")}</span>
    : <Image src={photo.image.src} srcSet={photo.image.srcset} alt={photo.alt} priority={priority} sizes="100vw" className="absolute inset-0 h-full w-full object-cover" style={{ objectPosition: photo.image.position }} onError={() => setFailed(true)} />;
}
export function DesktopGalleryViewV1({ model, dialogRef, dialogOpen, onOpen, onClose, primitives, copy = EN_STATIC_COPY_V1 }: { model: DetailGalleryModelV1; dialogRef?: Ref<HTMLDialogElement>; dialogOpen?: boolean; onOpen?: () => void; onClose?: () => void; primitives?: Partial<PresentationPrimitivesV1>; copy?: StaticCopyAccessorV1 }) {
  if (!model.photos.length) return null;
  const [cover, ...rest] = model.photos;
  const canOpenPhotos = model.photos.length > 1 && Boolean(onOpen);
  const small = rest.slice(0, 4);
  const columns = small.length >= 3 ? "grid-cols-[2fr_1fr_1fr]" : small.length ? "grid-cols-[2fr_1fr]" : "grid-cols-1";
  return <><div className={`relative mt-7 hidden h-[466px] grid-rows-2 gap-1.5 overflow-hidden rounded-3xl lg:grid ${columns}`} role="group" aria-label={copy.text("detail.photos")}>
    {canOpenPhotos ? <button type="button" aria-haspopup="dialog" aria-label={`${copy.text("detail.allPhotos")}: ${cover!.alt}`} onClick={onOpen} className="row-span-2 block h-full min-h-0 w-full cursor-zoom-in border-0 bg-transparent p-0 text-left focus-visible:z-[1] focus-visible:ring-4 focus-visible:ring-inset focus-visible:ring-ink"><PhotoV1 image={cover!.image} alt={cover!.alt} priority primitives={primitives} aspect="" rounded="" className="h-full" sizes="(min-width: 64rem) 780px, 100vw" /></button>
      : <PhotoV1 image={cover!.image} alt={cover!.alt} priority primitives={primitives} aspect="" rounded="" className="row-span-2 h-full" sizes="(min-width: 64rem) 780px, 100vw" />}
    {small.map((photo, index) => {
      const className = `block h-full min-h-0 w-full ${small.length === 1 ? "row-span-2" : small.length === 3 && index === 2 ? "col-span-2" : ""}`;
      const image = <PhotoV1 image={photo.image} alt={photo.alt} primitives={primitives} aspect="" rounded="" className="h-full" sizes="(min-width: 64rem) 300px, 50vw" />;
      return canOpenPhotos
        ? <button key={`${photo.image.src}-${index}`} type="button" aria-haspopup="dialog" aria-label={`${copy.text("detail.allPhotos")}: ${photo.alt}`} onClick={onOpen} className={`${className} cursor-zoom-in border-0 bg-transparent p-0 text-left focus-visible:z-[1] focus-visible:ring-4 focus-visible:ring-inset focus-visible:ring-ink`}>{image}</button>
        : <div key={`${photo.image.src}-${index}`} className={className}>{image}</div>;
    })}
    {model.photos.length > 1 ? <button type="button" onClick={onOpen} className="absolute right-4 bottom-4 z-[1] rounded-full bg-white px-4 py-2 text-sm font-extrabold text-ink shadow-[0_2px_10px_rgb(0_0_0/0.15)] hover:bg-sand">{copy.text("detail.showAllPhotos", { count: model.photos.length })}</button> : null}
  </div>{model.photos.length > 1 ? <dialog ref={dialogRef} open={dialogOpen || undefined} aria-labelledby="all-photos-heading-v1" onClick={onClose ? (event) => { if (event.target === event.currentTarget) onClose(); } : undefined} className="m-auto max-h-[90dvh] w-[min(64rem,calc(100vw_-_2rem))] overflow-y-auto rounded-3xl bg-white p-0 text-ink backdrop:bg-black/60">
    <div className="sticky top-0 z-[2] flex items-center justify-between gap-4 border-b border-line bg-white px-6 py-4"><h2 id="all-photos-heading-v1" className="text-2xl">{copy.text("detail.allPhotos")}</h2><button type="button" onClick={onClose} className="rounded-full px-4 py-2 text-sm font-extrabold shadow-[inset_0_0_0_1.5px_var(--color-ink)] hover:bg-sand">{copy.text("common.close")}</button></div>
    <ul className="grid gap-2 p-6 sm:grid-cols-2">{model.photos.map((photo, index) => <li key={`${photo.image.src}-${index}`}><PhotoV1 image={photo.image} alt={photo.alt} primitives={primitives} sizes="(min-width: 40rem) 500px, 100vw" rounded="rounded-2xl" /></li>)}</ul>
  </dialog> : null}</>;
}

export function DetailGalleryV1({ model, primitives, copy = EN_STATIC_COPY_V1, previewDialogOpen = false }: { model: DetailGalleryModelV1; primitives?: Partial<PresentationPrimitivesV1>; copy?: StaticCopyAccessorV1; previewDialogOpen?: boolean }) {
  return <><MobileGalleryViewV1 model={model} primitives={primitives} copy={copy} /><DesktopGalleryViewV1 model={model} dialogOpen={previewDialogOpen} primitives={primitives} copy={copy} /></>;
}
