import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/** The sign-in page with the NIHO account login on (Epic #591): the entrance, and the email form that stays behind `method=email`. */
const state = vi.hoisted(() => ({
  config: { hostConsoleEnabled: true, hostAccountsEnabled: true, hostNihoLoginEnabled: true },
  session: null as unknown,
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/config", () => ({ config: state.config }));
vi.mock("@/lib/host/server", () => ({ requireHostConsole: () => undefined, readHostSession: async () => state.session }));
vi.mock("@/components/host/HostAppWindow", () => ({ HostLoginLink: ({ href, children }: { href: string; children: unknown }) => ({ type: "a", props: { href, children }, key: null, $$typeof: Symbol.for("react.transitional.element") }) }));
vi.mock("next/navigation", () => ({
  notFound: () => { throw new Error("not-found"); },
  redirect: (to: string) => { throw new Error(`redirect:${to}`); },
}));

import HostSignInPage from "./page";

async function render(query: Record<string, string>): Promise<string> {
  return renderToStaticMarkup(await HostSignInPage({ searchParams: Promise.resolve(query) }));
}

beforeEach(() => {
  Object.assign(state.config, { hostConsoleEnabled: true, hostAccountsEnabled: true, hostNihoLoginEnabled: true });
  state.session = null;
});

describe("sign-in page", () => {
  it("keeps the return destination and gives hosts and travelers their public links", async () => {
    const html = await render({ next: "/write/new" });
    expect(html).toContain("ホストのログイン");
    expect(html).toContain("NIHO アカウントでログイン");
    expect(html).toContain('href="/host/auth/login?returnTo=%2Fwrite%2Fnew"');
    expect(html).toContain('href="/ja/host"');
    expect(html).toContain('href="/ja/help#find-booking"');
    for (const absent of ["メール", "<form", "<input", "体験の提供について"]) expect(html, absent).not.toContain(absent);
  });

  it("puts the site's wordmark above the page, outside main, and NIHO's mark on the button without a name of its own", async () => {
    const html = await render({});
    const [header, main] = html.split('<main id="main"');
    expect(header).toContain('href="/ja"');
    expect(header).toContain("NIHO Travel");
    expect(main).toContain('src="/host-app/icon-192.png" alt=""');
    expect(main).toMatch(/<span aria-hidden="true"[^>]*><img src="\/niho-mark.svg" alt=""/);
    // The email fallback keeps the same wordmark above it.
    expect(await render({ method: "email" })).toContain('href="/ja"');
  });

  it("sends a signed-in host on, and keeps the email form behind method=email", async () => {
    state.session = { kind: "experience" };
    await expect(render({ next: "/write" })).rejects.toThrow("redirect:/write");
    state.session = null;
    const form = await render({ method: "email" });
    expect(form).toContain("メールアドレス");
    expect(form).toContain("ログインのリンクを送る");
    expect(form).not.toContain("NIHO アカウントでログイン");
  });

  it("keeps method=email on 「もう一度送る」, so a resend stays on the email form", async () => {
    const html = await render({ method: "email", sent: "1" });
    expect(html).toContain("メールを確認してください");
    expect(html).toContain('href="/host/auth/sign-in?method=email"');
    const again = await render({ sent: "1", reauth: "1", next: "/host/settings?providerId=p_1#settings-payout" });
    // A re-login keeps its page and the method.
    expect(again).toMatch(/href="\/host\/auth\/sign-in\?method=email&amp;reauth=1&amp;next=/);
    // Without the NIHO account login the link is what it was.
    state.config.hostNihoLoginEnabled = false;
    expect(await render({ sent: "1" })).toContain('href="/host/auth/sign-in"');
  });
});
