import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import nextConfig from "../../../next.config";
import { HostStripeLogin } from "./HostStripeLogin";

describe("HostStripeLogin", () => {
  it("keeps same-origin POST Origin while preventing access to the opener", () => {
    const html = renderToStaticMarkup(createElement(HostStripeLogin, {
      providerId: "provider_synthetic",
      label: "Stripe で確認",
      className: "button",
    }));

    expect(html).toContain('method="post" target="_blank"');
    expect(html).toContain('rel="noopener"');
    expect(html).not.toContain("noreferrer");
  });

  it("allows only the Stripe hosts used by the account login redirects in form-action CSP", async () => {
    const headers = await nextConfig.headers!();
    const csp = headers.find((rule) => rule.source === "/:path*")?.headers.find((header) => header.key === "Content-Security-Policy")?.value;

    expect(csp).toContain("form-action 'self' https://checkout.stripe.com https://connect.stripe.com https://stripe.com");
  });
});
