import { createHash } from "node:crypto";
import { EXIT, OpsError, errorCode, failureOf, operationId, sendOnce, writeOne, type Action, type Context, type Target } from "./core.ts";

/*
 * 提供者（事務局の代理登録）(#576 ④): the providers a product can belong to, and a new one (name, kind and the consent to a
 * public profile). `/admin/api/product-workspaces`.
 */

const ROOT = "/admin/api/product-workspaces";
/** The consent wording version the server accepts (apps/web/src/lib/admin/admin-product-http.ts). */
export const PROVIDER_PUBLIC_PROFILE_CONSENT_VERSION = "provider-public-profile-v1";

/**
 * The English public name a command carries (#587): `--name-en <text>` sets it, `--clear-name-en` empties it, neither leaves it as it
 * is (undefined). Same rules as the Japanese name.
 */
function englishNameFlag(flags: Record<string, unknown>): string | null | undefined {
  const value = flags["name-en"];
  if (flags["clear-name-en"] === true) {
    if (value !== undefined) throw new OpsError("usage", "--name-en and --clear-name-en cannot be used together.", EXIT.usage);
    return null;
  }
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length < 1 || value.length > 300 || value !== value.trim() || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new OpsError("usage", "--name-en <English public name> must be 1-300 characters with no spaces at the ends.", EXIT.usage);
  }
  return value;
}

const list: Action = {
  tier: "read",
  summary: "Lists the providers (public name, English public name, kind) and the seller workspaces.",
  async run(context) {
    const response = await context.api.get(ROOT);
    if (response.status !== 200) throw failureOf(response, "provider list");
    const body = response.body as { providers?: unknown; sellers?: unknown } | null;
    return { providers: Array.isArray(body?.providers) ? body.providers : [], sellers: Array.isArray(body?.sellers) ? body.sellers : [] };
  },
};

const create: Action = {
  tier: "edit",
  summary: "Registers a provider with a public profile (--name <public display name>, --name-en <English public name, optional: the English site shows it>, --kind PERSON|BUSINESS, --consent-confirmed: the provider agreed to a public profile). Run `provider list` first: a name that already exists is reported, not duplicated.",
  async run(context) {
    const name = context.args.flags.name;
    const kind = context.args.flags.kind;
    if (typeof name !== "string" || name.length < 1 || name.length > 300 || name !== name.trim()) throw new OpsError("usage", "--name <public display name> is required (no spaces at the ends).", EXIT.usage);
    if (kind !== "PERSON" && kind !== "BUSINESS") throw new OpsError("usage", "--kind PERSON|BUSINESS is required.", EXIT.usage);
    if (context.args.flags["consent-confirmed"] !== true) throw new OpsError("usage", "--consent-confirmed is required: a person confirmed the provider agreed to a public profile.", EXIT.usage);
    const nameEn = englishNameFlag(context.args.flags);
    if (nameEn === null) throw new OpsError("usage", "--clear-name-en is for `provider profile`: a new provider has no English name to clear.", EXIT.usage);
    const listed = await context.api.get(ROOT);
    if (listed.status !== 200) throw failureOf(listed, "provider create");
    const providers = (listed.body as { providers?: Array<{ providerId: string; publicDisplayName: string | null }> } | null)?.providers ?? [];
    const found = providers.find((provider) => provider.publicDisplayName === name);
    if (found) return { status: "unchanged", providerId: found.providerId, note: "A provider with this public name already exists." };
    const body = { publicDisplayName: name, ...(nameEn === undefined ? {} : { publicDisplayNameEn: nameEn }), providerKind: kind, consentVersion: PROVIDER_PUBLIC_PROFILE_CONSENT_VERSION, consentConfirmed: true };
    if (!context.apply) return { status: "dry_run", create: { publicDisplayName: name, ...(nameEn === undefined ? {} : { publicDisplayNameEn: nameEn }), providerKind: kind } };
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

interface ProfileState { readonly publicDisplayName: string | null; readonly publicDisplayNameEn: string | null; readonly providerKind: string | null }

const profile: Action = {
  tier: "edit",
  summary: "Sets the public profile (public name and kind) of an existing provider (--provider, --name, --kind PERSON|BUSINESS, --consent-confirmed; --name-en <English public name> sets the English site's name, --clear-name-en empties it, and without either it stays as it is). A provider needs one before its products can be listed or published (a seller workspace made by an operations script has none).",
  async run(context) {
    const providerId = context.args.flags.provider;
    const name = context.args.flags.name;
    const kind = context.args.flags.kind;
    if (typeof providerId !== "string" || providerId === "") throw new OpsError("usage", "--provider <providerId> is required.", EXIT.usage);
    if (typeof name !== "string" || name.length < 1 || name.length > 300 || name !== name.trim()) throw new OpsError("usage", "--name <public display name> is required (no spaces at the ends).", EXIT.usage);
    if (kind !== "PERSON" && kind !== "BUSINESS") throw new OpsError("usage", "--kind PERSON|BUSINESS is required.", EXIT.usage);
    if (context.args.flags["consent-confirmed"] !== true) throw new OpsError("usage", "--consent-confirmed is required: a person confirmed the provider agreed to a public profile.", EXIT.usage);
    const nameEn = englishNameFlag(context.args.flags);
    let version: number | null = null;
    const url = `${ROOT}/${encodeURIComponent(providerId)}/profile`;
    const result = await writeOne<ProfileState>(context, ["provider-profile", providerId, name, kind, nameEn === undefined ? "-" : nameEn ?? "clear"], {
      key: providerId,
      read: async () => {
        const listed = await context.api.get(ROOT);
        if (listed.status !== 200) throw failureOf(listed, "provider profile");
        const found = ((listed.body as { providers?: Array<{ providerId: string; publicDisplayName: string | null; providerKind: string | null; profileVersion: number | null; publicDisplayNameEn?: string | null }> } | null)?.providers ?? []).find((item) => item.providerId === providerId);
        if (!found) throw new OpsError("not_found", `No provider ${providerId}.`, EXIT.failed);
        version = found.profileVersion;
        return { publicDisplayName: found.publicDisplayName, publicDisplayNameEn: found.publicDisplayNameEn ?? null, providerKind: found.providerKind };
      },
      // Without --name-en / --clear-name-en the English name stays as it is (and is not sent).
      desired: (current) => ({ publicDisplayName: name, publicDisplayNameEn: nameEn === undefined ? current.publicDisplayNameEn : nameEn, providerKind: kind }),
      send: async (_current, desired, operationId) => context.api.send("PUT", url, { expectedVersion: version, profile: { publicDisplayName: desired.publicDisplayName, ...(nameEn === undefined ? {} : { publicDisplayNameEn: desired.publicDisplayNameEn }), providerKind: desired.providerKind, consentVersion: PROVIDER_PUBLIC_PROFILE_CONSENT_VERSION, consentConfirmed: true } }, operationId),
    });
    if (result.status === "failed") throw new OpsError(result.error ?? "failed", "The profile was not saved.", result.error === "version_conflict" ? EXIT.conflict : EXIT.failed, { result });
    return result;
  },
};

const IMAGE_TYPES: Readonly<Record<string, string>> = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png" };
const b64url = (text: string) => Buffer.from(text, "utf8").toString("base64url");

const photoAdd: Action = {
  tier: "edit",
  summary: "Sets the provider's photo (the one 街の人 shows) or, with --logo, the business logo (--provider, --file image.jpg|png, --alt <English alt>, --alt-ja <日本語の説明>; --credit optional; --again to upload the same file once more). The provider needs a public profile first (`provider profile`). Only photos whose rights are cleared (the owner's rule): the confirmation the server asks for is sent. It replaces the current photo.",
  async run(context) {
    const flags = context.args.flags;
    const providerId = flags.provider;
    const file = flags.file;
    if (typeof providerId !== "string" || providerId === "") throw new OpsError("usage", "--provider <providerId> is required.", EXIT.usage);
    if (typeof file !== "string") throw new OpsError("usage", "--file <image.jpg|png> is required.", EXIT.usage);
    const type = IMAGE_TYPES[file.slice(file.lastIndexOf(".")).toLowerCase()];
    if (!type) throw new OpsError("usage", "The photo must be .jpg, .jpeg or .png.", EXIT.usage);
    const text = (name: string): string => {
      const value = flags[name];
      if (typeof value !== "string" || value.trim() === "" || value.length > 500) throw new OpsError("usage", `--${name} <text> is required (up to 500 characters).`, EXIT.usage);
      return value;
    };
    const alt = text("alt");
    const altJa = text("alt-ja");
    const credit = typeof flags.credit === "string" ? flags.credit : null;
    if (credit !== null && (credit.trim() === "" || credit.length > 300)) throw new OpsError("usage", "--credit must be 1-300 characters.", EXIT.usage);
    const bytes = context.readBytes(file);
    if (bytes.byteLength === 0 || bytes.byteLength > 10 * 1024 * 1024) throw new OpsError("invalid_file", "The photo must be 1 byte to 10 MB.");
    const placement = flags.logo === true ? "BUSINESS_LOGO" : "PROVIDER_PHOTO";
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const current = await context.api.get(`${ROOT}/${encodeURIComponent(providerId)}/profile`);
    if (current.status !== 200) throw failureOf(current, "provider photo-add");
    const media = (current.body as { providerMedia?: { version?: number } } | null)?.providerMedia;
    const version = typeof media?.version === "number" ? media.version : 1;
    if (!context.apply) return { status: "dry_run", photo: { placement, bytes: bytes.byteLength, contentType: type, alt, altJa, publicCredit: credit }, sha256, mediaVersion: version };
    const headers: Record<string, string> = {
      "x-experience-photo-rights-confirmed": "true", "x-experience-provider-profile-consent-version": PROVIDER_PUBLIC_PROFILE_CONSENT_VERSION,
      "x-experience-media-placement": placement, "x-experience-provider-media-version": String(version),
      "x-experience-photo-alt-text-utf8-base64url": b64url(alt), "x-experience-photo-alt-text-ja-utf8-base64url": b64url(altJa),
      ...(credit !== null ? { "x-experience-photo-credit-utf8-base64url": b64url(credit) } : {}),
    };
    const seed = ["provider-photo", providerId, placement, sha256, String(version), ...(flags.again === true ? [String(context.now())] : [])];
    const response = await context.api.send("POST", `${ROOT}/${encodeURIComponent(providerId)}/provider-media`, undefined, operationId(seed, 1, context.now()), { bytes, contentType: type, headers });
    if (response.status === 409 && errorCode(response.body) === "operation_already_recorded") throw new OpsError("photo_upload_unconfirmed", "This photo was sent before and the server cannot say whether it was stored: check `provider list`/`people list`; if it is missing, run the command again with --again.", EXIT.failed, { sha256 });
    if (response.status !== 201) throw failureOf(response, "provider photo-add");
    return { status: "applied", placement, sha256 };
  },
};

const HOSTS = "/admin/api/hosts";

interface HostRow {
  readonly providerId: string;
  readonly publicDisplayName: string | null;
  readonly publicPages: number;
  readonly sellingPages: number;
  readonly operationsSuspendedAtUtc: string | null;
  readonly operationsSuspensionCode: string | null;
}

async function readHosts(context: Context, action: string): Promise<readonly HostRow[]> {
  const response = await context.api.get(HOSTS);
  if (response.status !== 200) throw failureOf(response, action);
  const hosts = (response.body as { hosts?: unknown } | null)?.hosts;
  return Array.isArray(hosts) ? hosts as HostRow[] : [];
}

async function readHost(context: Context, providerId: string, action: string): Promise<HostRow> {
  // By its ID, not by looking through the newest 500 of the list: a host older than that is still found.
  const response = await context.api.get(`${HOSTS}/${encodeURIComponent(providerId)}`);
  if (response.status === 404) throw new OpsError("not_found", `No provider ${providerId}.`, EXIT.failed);
  if (response.status !== 200) throw failureOf(response, action);
  const host = (response.body as { host?: HostRow } | null)?.host;
  if (!host || host.providerId !== providerId) throw new OpsError("not_found", `No provider ${providerId}.`, EXIT.failed);
  return host;
}

const hosts: Action = {
  tier: "read",
  summary: "Lists the hosts (registration route, owners' accounts, public and selling pages, first publication and first bookings, suspension). Up to 500, newest first. Owners' email addresses are in the output: do not paste it outside the office.",
  async run(context) {
    return { hosts: await readHosts(context, "provider hosts") };
  },
};

const suspend: Action = {
  tier: "publish",
  summary: "Suspends a whole host (運営停止): --provider, --reason <CODE, A-Z 0-9 _> (e.g. POLICY_VIOLATION). Every public page and every booking of the host stops, and no new page or booking can start until `provider clear-suspension`. Without --yes it shows what would stop. Production needs the requester's go-ahead.",
  async run(context) {
    const providerId = context.args.flags.provider;
    const reason = context.args.flags.reason;
    if (typeof providerId !== "string" || providerId === "") throw new OpsError("usage", "--provider <providerId> is required.", EXIT.usage);
    if (typeof reason !== "string" || !/^[A-Z0-9_]{1,80}$/.test(reason)) throw new OpsError("usage", "--reason <CODE> is required (capital letters, digits and _).", EXIT.usage);
    const host = await readHost(context, providerId, "provider suspend");
    if (host.operationsSuspendedAtUtc !== null) return { status: "unchanged", note: "The host is already suspended.", host };
    if (!context.apply) return { status: "dry_run", wouldSuspend: { providerId, publicDisplayName: host.publicDisplayName, reason, publicPages: host.publicPages, sellingPages: host.sellingPages } };
    const url = `${HOSTS}/${encodeURIComponent(providerId)}/suspend`;
    const sent = await sendOnce(context, ["provider-suspend", providerId, reason], (id) => context.api.send("POST", url, { reasonCode: reason }, id), async () => {
      const after = await readHost(context, providerId, "provider suspend");
      return after.operationsSuspendedAtUtc !== null ? after : null;
    });
    if ("done" in sent) return { status: "unchanged", note: "The host is suspended.", host: sent.done };
    if (sent.response.status !== 200) throw failureOf(sent.response, "provider suspend");
    return { status: "applied", result: sent.response.body };
  },
};

const clearSuspension: Action = {
  tier: "publish",
  summary: "Lifts a host's suspension (--provider). Only the experiences the host suspension closed (PROVIDER_SUSPENDED) are lifted, and each one still waits for its owner to restart it. Without --yes it shows what would change.",
  async run(context) {
    const providerId = context.args.flags.provider;
    if (typeof providerId !== "string" || providerId === "") throw new OpsError("usage", "--provider <providerId> is required.", EXIT.usage);
    const host = await readHost(context, providerId, "provider clear-suspension");
    if (host.operationsSuspendedAtUtc === null) return { status: "unchanged", note: "The host is not suspended.", host };
    if (!context.apply) return { status: "dry_run", wouldClearSuspension: { providerId, publicDisplayName: host.publicDisplayName, reason: host.operationsSuspensionCode } };
    const url = `${HOSTS}/${encodeURIComponent(providerId)}/clear-suspension`;
    const sent = await sendOnce(context, ["provider-clear-suspension", providerId], (id) => context.api.send("POST", url, {}, id), async () => {
      const after = await readHost(context, providerId, "provider clear-suspension");
      return after.operationsSuspendedAtUtc === null ? after : null;
    });
    if ("done" in sent) return { status: "unchanged", note: "The suspension is lifted.", host: sent.done };
    if (sent.response.status !== 200) throw failureOf(sent.response, "provider clear-suspension");
    return { status: "applied", result: sent.response.body };
  },
};

export const providerTarget: Target = {
  summary: "Providers: who a product belongs to (public name and kind), the host list and host-wide suspension",
  actions: { list, create, profile, "photo-add": photoAdd, hosts, suspend, "clear-suspension": clearSuspension },
};

interface OwnerRow { readonly hostAccountId: string; readonly status: string }

async function readOwner(context: Context, accountId: string, action: string): Promise<OwnerRow | null> {
  for (const host of await readHosts(context, action) as unknown as Array<{ owners?: OwnerRow[] }>) {
    const found = host.owners?.find((owner) => owner.hostAccountId === accountId);
    if (found) return found;
  }
  return null;
}

function accountAction(kind: "suspend" | "reactivate"): Action {
  const wanted = kind === "suspend" ? "SUSPENDED" : "ACTIVE";
  return {
    tier: "publish",
    summary: kind === "suspend"
      ? "Suspends a host account (--account hst_…): its sessions and sign-in links stop at once and it gets no new link. Memberships and pages stay. Without --yes it shows what would change."
      : "Lets a suspended host account (--account hst_…) ask for sign-in links again. Earlier sessions stay ended. Without --yes it shows what would change.",
    async run(context) {
      const accountId = context.args.flags.account;
      if (typeof accountId !== "string" || !/^hst_[0-9a-f]{32}$/.test(accountId)) throw new OpsError("usage", "--account hst_<32 hex> is required.", EXIT.usage);
      // The list shows the accounts that own a host; one that owns none is still acted on (the server finds it).
      const owner = await readOwner(context, accountId, `host-account ${kind}`);
      if (owner?.status === wanted) return { status: "unchanged", note: kind === "suspend" ? "The account is already suspended." : "The account is already active.", account: owner };
      if (!context.apply) return { status: "dry_run", [kind === "suspend" ? "wouldSuspend" : "wouldReactivate"]: { accountId, current: owner?.status ?? "UNKNOWN" } };
      const url = `${HOSTS}/accounts/${encodeURIComponent(accountId)}/${kind}`;
      const sent = await sendOnce(context, [`host-account-${kind}`, accountId], (id) => context.api.send("POST", url, {}, id), async () => {
        const after = await readOwner(context, accountId, `host-account ${kind}`);
        return after?.status === wanted ? after : null;
      });
      if ("done" in sent) return { status: "unchanged", note: "The account is already in that state.", account: sent.done };
      if (sent.response.status !== 200) throw failureOf(sent.response, `host-account ${kind}`);
      return { status: "applied", result: sent.response.body };
    },
  };
}

export const hostAccountTarget: Target = {
  summary: "Host accounts (hst_…): suspend or reactivate a host's sign-in account",
  actions: { suspend: accountAction("suspend"), reactivate: accountAction("reactivate") },
};
