import { describe, expect, it, vi } from "vitest";
import { leaveFrameTo, postEmbedHeight, postEmbedTop } from "./embed-frame";

const STRIPE = "https://checkout.stripe.com/c/pay/cs_test_synthetic";

function topWindow() {
  const win = { top: null as unknown, location: { assign: vi.fn(), href: "" }, open: vi.fn() };
  win.top = win;
  return win;
}

function framedWindow(top: unknown) {
  return { top, location: { assign: vi.fn(), href: "" }, open: vi.fn() };
}

describe("leaveFrameTo", () => {
  it("navigates the page itself outside a frame", () => {
    const win = topWindow();
    expect(leaveFrameTo(STRIPE, win as never)).toBe("top");
    expect(win.location.assign).toHaveBeenCalledWith(STRIPE);
    expect(win.open).not.toHaveBeenCalled();
  });

  it("moves the top window by assigning href in a frame", () => {
    const top = { location: { href: "https://host.example.test/" } };
    const win = framedWindow(top);
    expect(leaveFrameTo(STRIPE, win as never)).toBe("top");
    expect(top.location.href).toBe(STRIPE);
    expect(win.location.assign).not.toHaveBeenCalled();
    expect(win.open).not.toHaveBeenCalled();
  });

  it("opens a new tab when the sandbox refuses top navigation", () => {
    const top = { location: {} };
    Object.defineProperty(top.location, "href", { set() { throw new Error("SecurityError"); } });
    const win = framedWindow(top);
    expect(leaveFrameTo(STRIPE, win as never)).toBe("tab");
    expect(win.open).toHaveBeenCalledWith(STRIPE, "_blank", "noopener,noreferrer");
  });

  it("leaves only for https, and http on localhost", () => {
    for (const url of ["http://checkout.example.test/", "javascript:alert(1)", "data:text/html,hi", "not a url"]) {
      const win = topWindow();
      expect(leaveFrameTo(url, win as never), url).toBeNull();
      expect(win.location.assign).not.toHaveBeenCalled();
      expect(win.open).not.toHaveBeenCalled();
    }
    const local = topWindow();
    expect(leaveFrameTo("http://localhost:3000/booking/return?type=instant", local as never)).toBe("top");
  });
});

describe("messages to the parent page", () => {
  const root = (bottom: number) => ({ getBoundingClientRect: () => ({ bottom }) as DOMRect });

  it("sends only the type and the height, and not the same height twice in a row", () => {
    const parent = { postMessage: vi.fn() };
    const win = { parent, scrollY: 10 };
    postEmbedHeight(root(700.2), win);
    postEmbedHeight(root(700.4), win);
    postEmbedHeight(root(820), win);
    postEmbedHeight(root(700.2), win);
    expect(parent.postMessage.mock.calls).toEqual([
      [{ type: "niho-experience-embed-resize", height: 711 }, "*"],
      [{ type: "niho-experience-embed-resize", height: 830 }, "*"],
      [{ type: "niho-experience-embed-resize", height: 711 }, "*"],
    ]);
  });

  it("asks the parent to scroll to the frame with nothing else in the message", () => {
    const parent = { postMessage: vi.fn() };
    postEmbedTop({ parent, scrollY: 0 });
    expect(parent.postMessage).toHaveBeenCalledWith({ type: "niho-experience-embed-top" }, "*");
  });

  it("sends nothing outside a frame", () => {
    const win = { parent: null as unknown, scrollY: 0, postMessage: vi.fn() };
    win.parent = win;
    postEmbedHeight(root(500), win as never);
    postEmbedTop(win as never);
    expect(win.postMessage).not.toHaveBeenCalled();
  });
});
