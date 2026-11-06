import { afterEach, describe, expect, it, vi } from "vitest";
import { clearSharedPhoto, holdSharedPhoto, markSharedPhotoMissed, sharedPhotoState, subscribeSharedPhoto, takeSharedPhotoFromWorker } from "./shared-photo";

const photo = (type = "image/jpeg", name = "kitchen.jpg", size = 8) => new File([new Uint8Array(size).fill(1)], name, { type });

afterEach(() => {
  clearSharedPhoto();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("the shared photo a page holds (#177 P3)", () => {
  it("holds one photo, tells listeners, and is empty again once used or dropped", () => {
    const heard = vi.fn();
    const stop = subscribeSharedPhoto(heard);
    expect(sharedPhotoState()).toEqual({ photo: null, missed: false });
    const file = photo();
    holdSharedPhoto(file);
    expect(sharedPhotoState()).toEqual({ photo: file, missed: false });
    clearSharedPhoto();
    expect(sharedPhotoState()).toEqual({ photo: null, missed: false });
    markSharedPhotoMissed();
    expect(sharedPhotoState()).toEqual({ photo: null, missed: true });
    expect(heard).toHaveBeenCalledTimes(3);
    // Clearing nothing is not a change.
    clearSharedPhoto();
    clearSharedPhoto();
    expect(heard).toHaveBeenCalledTimes(4);
    stop();
    holdSharedPhoto(file);
    expect(heard).toHaveBeenCalledTimes(4);
  });

  it("lets go of the photo after half an hour: it is only in this page's memory", () => {
    vi.useFakeTimers();
    holdSharedPhoto(photo());
    vi.advanceTimersByTime(30 * 60 * 1000 - 1);
    expect(sharedPhotoState().photo).not.toBeNull();
    vi.advanceTimersByTime(1);
    expect(sharedPhotoState()).toEqual({ photo: null, missed: false });
  });
});

describe("taking the photo from the worker", () => {
  /** A worker that answers the page's channel with this, or says nothing. */
  const worker = (reply: unknown | "silent") => {
    const target = { postMessage: vi.fn((message: unknown, ports?: MessagePort[]) => { if (reply !== "silent") ports![0]!.postMessage(reply); void message; }) };
    vi.stubGlobal("navigator", { serviceWorker: { controller: target, ready: new Promise(() => undefined) } });
    return target;
  };

  it("asks once with the take message and gets the photo", async () => {
    const file = photo();
    const target = worker({ type: "niho-host-share-take", photo: file });
    const taken = await takeSharedPhotoFromWorker();
    expect(taken?.name).toBe("kitchen.jpg");
    expect(target.postMessage).toHaveBeenCalledOnce();
    expect(target.postMessage.mock.calls[0]![0]).toEqual({ type: "niho-host-share-take" });
  });

  it("gets nothing when the worker held nothing, sent something that is not a usable image, or does not answer", async () => {
    worker({ type: "niho-host-share-take", photo: null });
    expect(await takeSharedPhotoFromWorker()).toBeNull();
    worker({ type: "niho-host-share-take", photo: photo("image/gif") });
    expect(await takeSharedPhotoFromWorker()).toBeNull();
    worker({ type: "niho-host-share-take", photo: photo("image/png", "empty.png", 0) });
    expect(await takeSharedPhotoFromWorker()).toBeNull();
    worker({ type: "niho-host-share-take", photo: "not a file" });
    expect(await takeSharedPhotoFromWorker()).toBeNull();
    vi.useFakeTimers();
    worker("silent");
    const waiting = takeSharedPhotoFromWorker();
    await vi.advanceTimersByTimeAsync(3001);
    expect(await waiting).toBeNull();
  });

  it("gets nothing without a service worker", async () => {
    vi.stubGlobal("navigator", {});
    expect(await takeSharedPhotoFromWorker()).toBeNull();
    vi.stubGlobal("navigator", { serviceWorker: { controller: null, ready: Promise.resolve({ active: null }) } });
    expect(await takeSharedPhotoFromWorker()).toBeNull();
  });
});
