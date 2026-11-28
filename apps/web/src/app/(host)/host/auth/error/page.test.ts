import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The sign-in's error page with the NIHO account login on: 「別の方法でやり直す」 asks NIHO for its account choice (#632,
 * `prompt=select_account` through `switch=1`) once NIHO takes it, since NIHO passes a host it knows straight back.
 */
const state = vi.hoisted(() => ({
  config: { hostConsoleEnabled: true, hostAccountsEnabled: true, hostNihoLoginEnabled: true, nihoLoginPromptEnabled: false },
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/config", () => ({ config: state.config }));
vi.mock("@/lib/host/server", () => ({ requireHostConsole: () => undefined }));
vi.mock("@/components/host/HostAppWindow", () => ({ HostLoginLink: ({ href, children }: { href: string; children: unknown }) => ({ type: "a", props: { href, children }, key: null, $$typeof: Symbol.for("react.transitional.element") }) }));

import HostLoginErrorPage from "./page";

async function render(query: Record<string, string>): Promise<string> {
  return renderToStaticMarkup(await HostLoginErrorPage({ searchParams: Promise.resolve(query) }));
}

beforeEach(() => {
  Object.assign(state.config, { hostConsoleEnabled: true, hostAccountsEnabled: true, hostNihoLoginEnabled: true, nihoLoginPromptEnabled: false });
});

describe("the sign-in's error page", () => {
  it("sends 「別の方法でやり直す」 to NIHO's account choice only while the flag is on", async () => {
    expect(await render({ reason: "unregistered" })).toContain('href="/host/auth/login"');
    state.config.nihoLoginPromptEnabled = true;
    const html = await render({ reason: "unregistered" });
    expect(html).toContain("別の方法でやり直す");
    expect(html).toContain('href="/host/auth/login?switch=1"');
  });

  it("takes an unregistered NIHO account on to 「ホストとして登録」 only with self-registration on (#708)", async () => {
    expect(await render({ reason: "unregistered" })).not.toContain("ホストとして登録");
    Object.assign(state.config, { hostSelfRegistrationEnabled: true });
    const html = await render({ reason: "unregistered" });
    expect(html).toContain('href="/host/auth/login?intent=register"');
    expect(html).toContain("ホストとして登録</a>");
    expect(html).toContain("別の方法でやり直す");
    delete (state.config as Record<string, unknown>).hostSelfRegistrationEnabled;
  });

  it("asks for the account choice on an invitation whose NIHO account is bound elsewhere, and nowhere else", async () => {
    state.config.nihoLoginPromptEnabled = true;
    expect(await render({ reason: "invite-in-use" })).toContain('href="/host/auth/login?invite=1&amp;switch=1"');
    expect(await render({ reason: "invite-unavailable" })).toContain('href="/host/auth/login?invite=1"');
    expect(await render({ reason: "unavailable" })).toContain('href="/host/auth/login"');
  });
});
