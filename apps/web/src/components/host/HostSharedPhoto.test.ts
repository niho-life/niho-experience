import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ pathname: "/host/home" }));
vi.mock("next/navigation", () => ({ usePathname: () => state.pathname }));

import { clearSharedPhoto, holdSharedPhoto, markSharedPhotoMissed } from "@/lib/host/shared-photo";
import { HostSharedPhotoNotice, HostSharedPhotoOffer } from "./HostSharedPhoto";

const photo = (name = "kitchen.jpg") => new File([new Uint8Array(4).fill(1)], name, { type: "image/jpeg" });
const offer = () => renderToStaticMarkup(createElement(HostSharedPhotoOffer, { disabled: false, onUse: () => undefined }));
const notice = () => renderToStaticMarkup(createElement(HostSharedPhotoNotice));

afterEach(() => {
  clearSharedPhoto();
  state.pathname = "/host/home";
});

describe("the shared photo in the console (#177 P3)", () => {
  it("shows nothing until a photo is shared", () => {
    expect(offer()).toBe("");
    expect(notice()).toBe("");
  });

  it("offers the held photo in the photo form, by name, to use or to drop", () => {
    holdSharedPhoto(photo("kitchen.jpg"));
    const html = offer();
    expect(html).toContain("kitchen.jpg");
    expect(html).toContain("この写真を使う");
    expect(html).toContain("使わない");
    expect(renderToStaticMarkup(createElement(HostSharedPhotoOffer, { disabled: true, onUse: () => undefined }))).toMatch(/disabled=""[^>]*>この写真を使う/);
  });

  it("tells the host where to use it, with a way into 体験 only away from it", () => {
    holdSharedPhoto(photo("<b>x</b>.jpg"));
    state.pathname = "/host/home";
    const away = notice();
    expect(away).toContain("共有された写真");
    expect(away).toContain('href="/host/experiences"');
    // The name is text, never markup.
    expect(away).not.toContain("<b>x</b>");
    state.pathname = "/host/experiences/abc";
    expect(notice()).not.toContain('href="/host/experiences"');
    state.pathname = "/host/experiences";
    expect(notice()).not.toContain('href="/host/experiences"');
  });

  it("says when a share did not arrive, and offers no photo", () => {
    markSharedPhotoMissed();
    const html = notice();
    expect(html).toContain("共有された写真を受け取れませんでした");
    expect(html).toContain("閉じる");
    expect(html).not.toContain("体験を開く");
    expect(offer()).toBe("");
  });
});
