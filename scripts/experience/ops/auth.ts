import { EXIT, OpsError, failureOf, type Target } from "./core.ts";

/** `auth check`: is this machine's Google account accepted by the site? Reads one admin list; prints only a count. */
export const authTarget: Target = {
  summary: "Sign-in check",
  actions: {
    check: {
      tier: "read",
      summary: "Checks that the Google ID token is accepted and the account is on the Admin allowlist.",
      async run(context) {
        const response = await context.api.get("/admin/api/product-classifications");
        if (response.status === 404) throw new OpsError("cli_not_open", "The CLI is not open on this site (EXPERIENCE_OPERATOR_CLI_ENABLED is off or the release is older).", EXIT.failed, { status: 404 });
        if (response.status !== 200) throw failureOf(response, "auth check");
        const products = (response.body as { products?: unknown } | null)?.products;
        return { signedIn: true, aiKind: context.api.aiKind, productCount: Array.isArray(products) ? products.length : null };
      },
    },
  },
};
