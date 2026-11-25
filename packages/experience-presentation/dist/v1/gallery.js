"use client";
import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useId, useRef, useState } from "react";
import { HandIcon, PhotoV1 } from "./components.js";
import { EN_STATIC_COPY_V1 } from "./static-copy.js";
import { primitivesV1 } from "./types.js";
export function MobileGalleryViewV1({ model, index = 0, onPositionChange, onPhotoClick, primitives, copy = EN_STATIC_COPY_V1 }) {
    const { Link, Image } = primitivesV1(primitives);
    const count = model.photos.length;
    const canOpenPhotos = count > 1 && Boolean(onPhotoClick);
    const galleryId = useId();
    const track = useRef(null);
    const [localIndex, setLocalIndex] = useState(index);
    const currentIndex = onPositionChange ? index : localIndex;
    const setPosition = (next) => {
        if (!count)
            return;
        const position = Math.max(0, Math.min(count - 1, next));
        setLocalIndex(position);
        onPositionChange?.(position);
    };
    const showPhoto = (next) => {
        if (!count)
            return;
        const position = Math.max(0, Math.min(count - 1, next));
        const element = track.current;
        element?.scrollTo({ left: position * (element.clientWidth || 1), behavior: "instant" });
        setPosition(position);
    };
    return _jsxs("div", { className: "relative lg:hidden", children: [_jsx("div", { ref: track, id: galleryId, tabIndex: 0, role: "region", "aria-roledescription": "carousel", "aria-label": copy.text("detail.photosOf", { title: model.title }), "aria-describedby": count > 1 ? `${galleryId}-help` : undefined, onKeyDown: (event) => {
                    const next = event.key === "ArrowRight" ? currentIndex + 1 : event.key === "ArrowLeft" ? currentIndex - 1 : event.key === "Home" ? 0 : event.key === "End" ? count - 1 : null;
                    if (next !== null) {
                        event.preventDefault();
                        showPhoto(next);
                    }
                }, onScroll: (event) => {
                    const element = event.currentTarget;
                    setPosition(Math.round(element.scrollLeft / Math.max(1, element.clientWidth)));
                }, className: "scrollbar-none flex snap-x snap-mandatory overflow-x-auto", children: count ? model.photos.map((photo, photoIndex) => _jsx("div", { className: "relative aspect-square w-full shrink-0 snap-start bg-sand sm:aspect-[16/10]", children: canOpenPhotos
                        ? _jsx("button", { type: "button", "aria-haspopup": "dialog", "aria-label": `${photo.alt}. ${copy.text("detail.showAllPhotos", { count })}`, onClick: onPhotoClick, className: "absolute inset-0 block w-full cursor-zoom-in border-0 bg-transparent p-0 text-left focus-visible:z-[1] focus-visible:ring-4 focus-visible:ring-inset focus-visible:ring-ink", children: _jsx(GalleryPhotoV1, { Image: Image, photo: photo, priority: photoIndex === 0, copy: copy }) })
                        : _jsx(GalleryPhotoV1, { Image: Image, photo: photo, priority: photoIndex === 0, copy: copy }) }, `${photo.image.src}-${photoIndex}`))
                    : _jsx("div", { role: "img", "aria-label": copy.text("detail.photosUnavailable", { title: model.title }), className: "aspect-[16/10] w-full bg-sand" }) }), count > 1 ? _jsx("p", { id: `${galleryId}-help`, className: "sr-only", children: copy.text("detail.galleryKeyboardHelp") }) : null, _jsx(Link, { href: model.backHref, "aria-label": copy.text("chrome.allExperiences"), className: "absolute top-3.5 left-3.5 grid size-11 place-items-center rounded-full bg-white/95 shadow-[0_2px_8px_rgb(0_0_0/0.15)]", children: _jsx(HandIcon, { name: "back", className: "size-5 [stroke-width:2.2]" }) }), count > 1 ? _jsxs("div", { className: "absolute right-3.5 bottom-3.5 flex items-center gap-1 rounded-full bg-ink/85 p-1 text-[0.8125rem] font-extrabold text-white", children: [_jsx("button", { type: "button", "aria-label": copy.text("detail.previousPhoto"), "aria-controls": galleryId, disabled: currentIndex === 0, onClick: () => showPhoto(currentIndex - 1), className: "grid size-11 place-items-center rounded-full hover:bg-white/20 disabled:opacity-40", children: _jsx(HandIcon, { name: "back", className: "size-5" }) }), _jsxs("span", { role: "status", "aria-atomic": "true", className: "min-w-12 text-center", children: [_jsx("span", { className: "sr-only", children: copy.text("detail.photoPosition", { title: model.title, position: currentIndex + 1, count }) }), _jsxs("span", { "aria-hidden": true, children: [currentIndex + 1, " / ", count] })] }), _jsx("button", { type: "button", "aria-label": copy.text("detail.nextPhoto"), "aria-controls": galleryId, disabled: currentIndex === count - 1, onClick: () => showPhoto(currentIndex + 1), className: "grid size-11 place-items-center rounded-full hover:bg-white/20 disabled:opacity-40", children: _jsx(HandIcon, { name: "back", className: "size-5 rotate-180" }) })] }) : null] });
}
function GalleryPhotoV1({ Image, photo, priority, copy }) {
    const [failed, setFailed] = useState(false);
    return failed
        ? _jsx("span", { role: "img", "aria-label": photo.alt, className: "absolute inset-0 flex items-center justify-center text-sm text-muted", children: copy.text("detail.photoUnavailable") })
        : _jsx(Image, { src: photo.image.src, srcSet: photo.image.srcset, alt: photo.alt, priority: priority, sizes: "100vw", className: "absolute inset-0 h-full w-full object-cover", style: { objectPosition: photo.image.position }, onError: () => setFailed(true) });
}
export function DesktopGalleryViewV1({ model, dialogRef, dialogOpen, onOpen, onClose, primitives, copy = EN_STATIC_COPY_V1 }) {
    if (!model.photos.length)
        return null;
    const [cover, ...rest] = model.photos;
    const canOpenPhotos = model.photos.length > 1 && Boolean(onOpen);
    const small = rest.slice(0, 4);
    const columns = small.length >= 3 ? "grid-cols-[2fr_1fr_1fr]" : small.length ? "grid-cols-[2fr_1fr]" : "grid-cols-1";
    return _jsxs(_Fragment, { children: [_jsxs("div", { className: `relative mt-7 hidden h-[466px] grid-rows-2 gap-1.5 overflow-hidden rounded-3xl lg:grid ${columns}`, role: "group", "aria-label": copy.text("detail.photos"), children: [canOpenPhotos ? _jsx("button", { type: "button", "aria-haspopup": "dialog", "aria-label": `${cover.alt}. ${copy.text("detail.showAllPhotos", { count: model.photos.length })}`, onClick: onOpen, className: "row-span-2 block h-full min-h-0 w-full cursor-zoom-in border-0 bg-transparent p-0 text-left focus-visible:z-[1] focus-visible:ring-4 focus-visible:ring-inset focus-visible:ring-ink", children: _jsx(PhotoV1, { image: cover.image, alt: cover.alt, priority: true, primitives: primitives, aspect: "", rounded: "", className: "h-full", sizes: "(min-width: 64rem) 780px, 100vw" }) })
                        : _jsx(PhotoV1, { image: cover.image, alt: cover.alt, priority: true, primitives: primitives, aspect: "", rounded: "", className: "row-span-2 h-full", sizes: "(min-width: 64rem) 780px, 100vw" }), small.map((photo, index) => {
                        const className = `block h-full min-h-0 w-full ${small.length === 1 ? "row-span-2" : small.length === 3 && index === 2 ? "col-span-2" : ""}`;
                        const image = _jsx(PhotoV1, { image: photo.image, alt: photo.alt, primitives: primitives, aspect: "", rounded: "", className: "h-full", sizes: "(min-width: 64rem) 300px, 50vw" });
                        return canOpenPhotos
                            ? _jsx("button", { type: "button", "aria-haspopup": "dialog", "aria-label": `${photo.alt}. ${copy.text("detail.showAllPhotos", { count: model.photos.length })}`, onClick: onOpen, className: `${className} cursor-zoom-in border-0 bg-transparent p-0 text-left focus-visible:z-[1] focus-visible:ring-4 focus-visible:ring-inset focus-visible:ring-ink`, children: image }, `${photo.image.src}-${index}`)
                            : _jsx("div", { className: className, children: image }, `${photo.image.src}-${index}`);
                    }), canOpenPhotos ? _jsx("button", { type: "button", onClick: onOpen, className: "absolute right-4 bottom-4 z-[1] rounded-full bg-white px-4 py-2 text-sm font-extrabold text-ink shadow-[0_2px_10px_rgb(0_0_0/0.15)] hover:bg-sand", children: copy.text("detail.showAllPhotos", { count: model.photos.length }) }) : null] }), model.photos.length > 1 ? _jsxs("dialog", { ref: dialogRef, open: dialogOpen || undefined, "aria-labelledby": "all-photos-heading-v1", onClick: onClose ? (event) => { if (event.target === event.currentTarget)
                    onClose(); } : undefined, className: "m-auto max-h-[90dvh] w-[min(64rem,calc(100vw_-_2rem))] overflow-y-auto rounded-3xl bg-white p-0 text-ink backdrop:bg-black/60", children: [_jsxs("div", { className: "sticky top-0 z-[2] flex items-center justify-between gap-4 border-b border-line bg-white px-6 py-4", children: [_jsx("h2", { id: "all-photos-heading-v1", className: "text-2xl", children: copy.text("detail.allPhotos") }), _jsx("button", { type: "button", onClick: onClose, className: "rounded-full px-4 py-2 text-sm font-extrabold shadow-[inset_0_0_0_1.5px_var(--color-ink)] hover:bg-sand", children: copy.text("common.close") })] }), _jsx("ul", { className: "grid gap-2 p-6 sm:grid-cols-2", children: model.photos.map((photo, index) => _jsx("li", { children: _jsx(PhotoV1, { image: photo.image, alt: photo.alt, primitives: primitives, sizes: "(min-width: 40rem) 500px, 100vw", rounded: "rounded-2xl" }) }, `${photo.image.src}-${index}`)) })] }) : null] });
}
export function DetailGalleryV1({ model, primitives, copy = EN_STATIC_COPY_V1, previewDialogOpen = false }) {
    return _jsxs(_Fragment, { children: [_jsx(MobileGalleryViewV1, { model: model, primitives: primitives, copy: copy }), _jsx(DesktopGalleryViewV1, { model: model, dialogOpen: previewDialogOpen, primitives: primitives, copy: copy })] });
}
