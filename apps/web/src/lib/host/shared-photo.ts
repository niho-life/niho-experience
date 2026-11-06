import { HOST_SHARE_PAGE_HOLD_MS, HOST_SHARE_PHOTO_MAX_BYTES, HOST_SHARE_PHOTO_TYPES, HOST_SHARE_TAKE_MESSAGE } from "./display";

/**
 * The photo a host shared to the app from Android's share sheet (#177 P3), as the page holds it. It lives in this
 * module's memory only: not in storage, not in the URL, and not on the server. The photo form (体験 › 写真) offers it, and
 * the host still confirms the rights and writes the descriptions as with any photo. A reload or half an hour drops it.
 */
export interface SharedPhotoState {
  readonly photo: File | null;
  /** The host shared a photo but it did not arrive (no worker, the worker stopped, or it was not a usable image). */
  readonly missed: boolean;
}

const EMPTY: SharedPhotoState = { photo: null, missed: false };
let state: SharedPhotoState = EMPTY;
let expiry: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

function replace(next: SharedPhotoState) {
  state = next;
  if (expiry) clearTimeout(expiry);
  expiry = next.photo ? setTimeout(clearSharedPhoto, HOST_SHARE_PAGE_HOLD_MS) : null;
  for (const listener of listeners) listener();
}

/** For useSyncExternalStore; each change replaces the state object. */
export function subscribeSharedPhoto(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function sharedPhotoState(): SharedPhotoState {
  return state;
}

export function holdSharedPhoto(photo: File) {
  replace({ photo, missed: false });
}

export function markSharedPhotoMissed() {
  replace({ photo: null, missed: true });
}

export function clearSharedPhoto() {
  if (state !== EMPTY) replace(EMPTY);
}

function usable(value: unknown): value is File {
  return typeof File !== "undefined" && value instanceof File
    && (HOST_SHARE_PHOTO_TYPES as readonly string[]).includes(value.type) && value.size > 0 && value.size <= HOST_SHARE_PHOTO_MAX_BYTES;
}

const ASK_TIMEOUT_MS = 3000;

/**
 * Asks the worker for the photo it holds, once. The worker forgets it as it answers. Null when there is no worker, it
 * does not answer in time, or it held nothing usable.
 */
export async function takeSharedPhotoFromWorker(): Promise<File | null> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return null;
  const timeout = <T,>(value: T) => new Promise<T>((resolve) => { setTimeout(() => resolve(value), ASK_TIMEOUT_MS); });
  try {
    const target = navigator.serviceWorker.controller ?? (await Promise.race([navigator.serviceWorker.ready.then((registration) => registration.active), timeout(null)]));
    if (!target) return null;
    const channel = new MessageChannel();
    try {
      const answer = new Promise<File | null>((resolve) => {
        channel.port1.onmessage = (event: MessageEvent) => {
          const photo = (event.data as { photo?: unknown } | null)?.photo;
          resolve(usable(photo) ? photo : null);
        };
      });
      target.postMessage({ type: HOST_SHARE_TAKE_MESSAGE }, [channel.port2]);
      return await Promise.race([answer, timeout(null)]);
    } finally {
      channel.port1.close();
    }
  } catch {
    return null;
  }
}
