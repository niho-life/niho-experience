"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";

/*
 * 説明の「i」: a round button that opens a small bubble with the explanation, instead of a standing paragraph.
 * Pressing it again, pressing outside, scrolling or Esc closes it. The bubble is a manual popover (the top layer),
 * so it shows above a modal <dialog> as well.
 */
export function HostInfoTip({ label, children }: { label: string; children: string }) {
  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState<{ left: number; top: number; arrow: number } | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const bubble = useRef<HTMLDivElement>(null);
  const id = useId();

  const close = useCallback(() => setOpen(false), []);

  // The bubble exists only while open; the top layer (above a modal <dialog>) is asked for when it appears.
  useEffect(() => {
    const element = bubble.current;
    if (!open || !element) return;
    try { if (!element.matches(":popover-open")) element.showPopover(); } catch { /* A browser without popover shows it in place. */ }
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: Event) => {
      const target = event.target as Node | null;
      if (target && (button.current?.contains(target) || bubble.current?.contains(target))) return;
      close();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      close();
      button.current?.focus();
    };
    document.addEventListener("pointerdown", onPointer, true);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("scroll", close, { passive: true, capture: true });
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("pointerdown", onPointer, true);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [close, open]);

  function toggle() {
    if (open) { close(); return; }
    const rect = button.current?.getBoundingClientRect();
    if (rect) {
      const width = Math.min(300, window.innerWidth - 24);
      const left = Math.max(12, Math.min(rect.left - 14, window.innerWidth - width - 12));
      setPlace({ left, top: rect.bottom + 8, arrow: Math.max(12, rect.left + rect.width / 2 - left - 6) });
    }
    setOpen(true);
  }

  return (
    <>
      <button
        ref={button}
        type="button"
        aria-label={`${label}の説明`}
        aria-expanded={open}
        aria-controls={id}
        onClick={toggle}
        className={`relative ml-1.5 inline-grid size-[18px] shrink-0 -translate-y-px place-items-center rounded-full border-[1.5px] align-middle font-serif text-[0.71875rem] leading-none font-bold italic after:absolute after:-inset-[11px] after:content-[''] ${open ? "border-ink bg-ink text-canvas" : "border-line-strong bg-canvas text-muted hover:border-ink hover:bg-ink hover:text-canvas"}`}
      >i</button>
      {open ? <div
        ref={bubble}
        id={id}
        role="note"
        popover="manual"
        style={place ? { left: place.left, top: place.top, ["--arrow" as string]: `${place.arrow}px` } : undefined}
        className="fixed inset-auto m-0 w-max max-w-[min(300px,calc(100vw-24px))] overflow-visible rounded-xl border border-line-strong bg-canvas px-3.5 py-2.5 text-[0.78125rem] leading-[1.75] font-normal text-ink-soft shadow-[0_10px_30px_rgb(28_28_26/0.14)] before:absolute before:-top-1.5 before:left-[var(--arrow,16px)] before:size-2.5 before:rotate-45 before:border-t before:border-l before:border-line-strong before:bg-canvas before:content-['']"
      >{children}</div> : null}
    </>
  );
}
