import { useEffect, type RefObject } from "react";

/*
 * The booking widget and the page that frames it (#638, docs/embed.md「親ページへのメッセージ」). The widget sends the parent
 * only its height and "scroll to my top", with no name, address, payment URL, booking ID or error in them, and never listens
 * to the parent. Payment leaves the frame only from a button the traveler pressed.
 */

export const EMBED_RESIZE_MESSAGE = "niho-experience-embed-resize";
export const EMBED_TOP_MESSAGE = "niho-experience-embed-top";

type LeavingWindow = { readonly top: LeavingWindow | null; readonly location: { assign(url: string): void; href: string }; open(url: string, target: string, features: string): unknown };
type MessagingWindow = { readonly parent: { postMessage(message: unknown, targetOrigin: string): void }; readonly scrollY: number };

/** Only https, and http on localhost while developing. */
function leavableUrl(url: string): boolean {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return false; }
  return parsed.protocol === "https:" || (parsed.protocol === "http:" && (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1"));
}

/**
 * Opens `url` in the top window. Outside a frame this is a plain navigation. In a frame, a cross-origin `Location` takes
 * only an `href` assignment; a sandbox without top navigation throws, and then the URL opens in a new tab.
 * Returns null and does nothing for a URL that is not https.
 */
export function leaveFrameTo(url: string, win: LeavingWindow = window as unknown as LeavingWindow): "top" | "tab" | null {
  if (!leavableUrl(url)) return null;
  if (win.top === win) {
    win.location.assign(url);
    return "top";
  }
  try {
    if (!win.top) throw new Error("No top window.");
    win.top.location.href = url;
    return "top";
  } catch {
    win.open(url, "_blank", "noopener,noreferrer");
    return "tab";
  }
}

const lastHeights = new WeakMap<object, number>();

function framed(win: MessagingWindow): boolean {
  return (win.parent as unknown) !== win;
}

/** Tells the parent the widget's height (px), once per change (or again with `force`). Nothing outside a frame. */
export function postEmbedHeight(root: Pick<HTMLElement, "getBoundingClientRect">, win: MessagingWindow = window as unknown as MessagingWindow, force = false): void {
  if (!framed(win)) return;
  const height = Math.ceil(root.getBoundingClientRect().bottom + win.scrollY);
  if (!Number.isFinite(height) || (!force && lastHeights.get(win) === height)) return;
  lastHeights.set(win, height);
  win.parent.postMessage({ type: EMBED_RESIZE_MESSAGE, height }, "*");
}

/** Asks the parent to scroll the frame's top into view (after a step changes). Nothing outside a frame. */
export function postEmbedTop(win: MessagingWindow = window as unknown as MessagingWindow): void {
  if (!framed(win)) return;
  win.parent.postMessage({ type: EMBED_TOP_MESSAGE }, "*");
}

/** Sends the root's height when it mounts and whenever its size changes. */
export function useEmbedFrame(ref: RefObject<HTMLElement | null>, enabled: boolean): void {
  useEffect(() => {
    const root = ref.current;
    if (!enabled || !root) return;
    postEmbedHeight(root);
    // A parent page whose listener starts late missed the first height: say it once more.
    const again = window.setTimeout(() => postEmbedHeight(root, undefined, true), 1500);
    if (typeof ResizeObserver === "undefined") return () => window.clearTimeout(again);
    const observer = new ResizeObserver(() => postEmbedHeight(root));
    observer.observe(root);
    return () => { window.clearTimeout(again); observer.disconnect(); };
  }, [ref, enabled]);
}
