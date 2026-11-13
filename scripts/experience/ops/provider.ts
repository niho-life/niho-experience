import { EXIT, OpsError, failureOf, sendOnce, type Action, type Target } from "./core.ts";

/*
 * 提供者（事務局の代理登録）(#576 ④): the providers a product can belong to, and a new one (name, kind and the consent to a
 * public profile). `/admin/api/product-workspaces`.
 */

const ROOT = "/admin/api/product-workspaces";
/** The consent wording version the server accepts (apps/web/src/lib/admin/admin-product-http.ts). */
export const PROVIDER_PUBLIC_PROFILE_CONSENT_VERSION = "provider-public-profile-v1";

const list: Action = {
  tier: "read",
  summary: "Lists the providers (public name, kind) and the seller workspaces.",
  async run(context) {
    const response = await context.api.get(ROOT);
    if (response.status !== 200) throw failureOf(response, "provider list");
    const body = response.body as { providers?: unknown; sellers?: unknown } | null;
    return { providers: Array.isArray(body?.providers) ? body.providers : [], sellers: Array.isArray(body?.sellers) ? body.sellers : [] };
  },
};

const create: Action = {
  tier: "edit",
  summary: "Registers a provider with a public profile (--name <public display name>, --kind PERSON|BUSINESS, --consent-confirmed: the provider agreed to a public profile). Run `provider list` first: a name that already exists is reported, not duplicated.",
  async run(context) {
    const name = context.args.flags.name;
    const kind = context.args.flags.kind;
    if (typeof name !== "string" || name.length < 1 || name.length > 300 || name !== name.trim()) throw new OpsError("usage", "--name <public display name> is required (no spaces at the ends).", EXIT.usage);
    if (kind !== "PERSON" && kind !== "BUSINESS") throw new OpsError("usage", "--kind PERSON|BUSINESS is required.", EXIT.usage);
    if (context.args.flags["consent-confirmed"] !== true) throw new OpsError("usage", "--consent-confirmed is required: a person confirmed the provider agreed to a public profile.", EXIT.usage);
    const listed = await context.api.get(ROOT);
    if (listed.status !== 200) throw failureOf(listed, "provider create");
    const providers = (listed.body as { providers?: Array<{ providerId: string; publicDisplayName: string | null }> } | null)?.providers ?? [];
    const found = providers.find((provider) => provider.publicDisplayName === name);
    if (found) return { status: "unchanged", providerId: found.providerId, note: "A provider with this public name already exists." };
    const body = { publicDisplayName: name, providerKind: kind, consentVersion: PROVIDER_PUBLIC_PROFILE_CONSENT_VERSION, consentConfirmed: true };
    if (!context.apply) return { status: "dry_run", create: { publicDisplayName: name, providerKind: kind } };
    const sent = await sendOnce(context, ["provider-create", name], (operationId) => context.api.send("POST", ROOT, body, operationId), async () => {
      const again = await context.api.get(ROOT);
      const found = ((again.body as { providers?: Array<{ providerId: string; publicDisplayName: string | null }> } | null)?.providers ?? []).find((provider) => provider.publicDisplayName === name);
      return found ?? null;
    });
    if ("done" in sent) return { status: "unchanged", providerId: sent.done.providerId };
    if (sent.response.status !== 201) throw failureOf(sent.response, "provider create");
    return { status: "applied", profile: (sent.response.body as { profile?: unknown } | null)?.profile ?? null };
  },
};

export const providerTarget: Target = {
  summary: "Providers: who a product belongs to (public name and kind)",
  actions: { list, create },
};
