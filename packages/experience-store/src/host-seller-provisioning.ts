import { StoreError } from "./errors.ts";
import type { HostSellerProvisioningInput, HostSellerProvisioningState, SiteSaleRegistration } from "./site-sale-registration.ts";
import type { SiteSaleAccountCheck } from "./site-sale-script.ts";

export const HOST_SELLER_PROVISIONING_EXIT = { ok: 0, failed: 1, unexpected: 2 } as const;
export const HOST_SELLER_PROVISIONING_USAGE =
  "Usage: node scripts/experience/provision-host-seller.mjs [plan|register] <input.json> [--yes]";

export interface HostSellerProvisioningFile {
  readonly provider: { readonly id: string; readonly legacyProviderId: string; readonly displayName: string };
  readonly seller: { readonly nihoAccountRef: string; readonly stripeConnectAccountRef: string; readonly displayName: string };
  readonly supportEnabled: boolean;
}

export interface HostSellerProvisioningArguments {
  readonly command: "plan" | "register";
  readonly inputPath: string;
  readonly yes: boolean;
}

export class HostSellerProvisioningInputError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`The host seller provisioning input is invalid: ${problems.join("; ")}`);
    this.name = "HostSellerProvisioningInputError";
    this.problems = problems;
  }
}

const CONTROL = /[\u0000-\u001F\u007F]/;
const PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;
const LEGACY_PROVIDER_ID = /^[A-Za-z0-9_-]{1,200}$/;
const CONNECT_ACCOUNT_ID = /^acct_[A-Za-z0-9]{8,250}$/;

type Json = Record<string, unknown>;

function objectAt(value: unknown, path: string, keys: readonly string[], problems: string[]): Json | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    problems.push(`${path} must be an object`);
    return null;
  }
  const record = value as Json;
  for (const key of Object.keys(record)) if (!keys.includes(key)) problems.push(`${path}.${key} is not a known field`);
  for (const key of keys) if (!(key in record)) problems.push(`${path}.${key} is missing`);
  return record;
}

function textAt(value: unknown, path: string, max: number, problems: string[]): string {
  if (typeof value !== "string" || value.trim() !== value || value.length < 1 || value.length > max || CONTROL.test(value)) {
    problems.push(`${path} must be one line of 1-${max} characters without surrounding spaces`);
    return "";
  }
  return value;
}

function patternAt(value: unknown, path: string, pattern: RegExp, rule: string, problems: string[]): string {
  if (typeof value !== "string" || !pattern.test(value)) {
    problems.push(`${path} must be ${rule}`);
    return "";
  }
  return value;
}

/** Strictly parse a synthetic or operator-supplied profile. Product, publication, and OWNER fields are rejected. */
export function parseHostSellerProvisioningFile(raw: unknown): HostSellerProvisioningFile {
  const problems: string[] = [];
  const root = objectAt(raw, "input", ["provider", "seller", "supportEnabled"], problems);
  if (root === null) throw new HostSellerProvisioningInputError(problems);
  const provider = objectAt(root.provider, "provider", ["id", "legacyProviderId", "displayName"], problems);
  const seller = objectAt(root.seller, "seller", ["nihoAccountRef", "stripeConnectAccountRef", "displayName"], problems);
  if (typeof root.supportEnabled !== "boolean") problems.push("supportEnabled must be true or false");
  const parsed = {
    provider: {
      id: provider ? patternAt(provider.id, "provider.id", PROVIDER_ID, "an Experience provider ID", problems) : "",
      legacyProviderId: provider ? patternAt(provider.legacyProviderId, "provider.legacyProviderId", LEGACY_PROVIDER_ID, "NIHO's explicit legacy Connect lookup ID", problems) : "",
      displayName: provider ? textAt(provider.displayName, "provider.displayName", 300, problems) : "",
    },
    seller: {
      nihoAccountRef: seller ? textAt(seller.nihoAccountRef, "seller.nihoAccountRef", 128, problems) : "",
      stripeConnectAccountRef: seller ? patternAt(seller.stripeConnectAccountRef, "seller.stripeConnectAccountRef", CONNECT_ACCOUNT_ID, "a Stripe connected account ID (acct_…)", problems) : "",
      displayName: seller ? textAt(seller.displayName, "seller.displayName", 300, problems) : "",
    },
    supportEnabled: root.supportEnabled === true,
  };
  if (problems.length > 0) throw new HostSellerProvisioningInputError(problems);
  return parsed;
}

export function parseHostSellerProvisioningArguments(argv: readonly string[]): HostSellerProvisioningArguments {
  const yes = argv.includes("--yes");
  const rest = argv.filter((value) => value !== "--yes");
  if (rest.some((value) => value.startsWith("-"))) throw new HostSellerProvisioningInputError(["unknown option (only --yes is accepted)"]);
  const [first, second, ...extra] = rest;
  const command = first === "register" || first === "plan" ? first : "plan";
  const inputPath = command === "plan" && first !== "plan" ? first : second;
  if (inputPath === undefined || inputPath.length === 0 || (command === "register" && second === undefined)) {
    throw new HostSellerProvisioningInputError(["the input file path is missing"]);
  }
  if ((command === "register" ? extra[0] : (first === "plan" ? extra[0] : second)) !== undefined) {
    throw new HostSellerProvisioningInputError(["unknown command or extra arguments"]);
  }
  if (yes && command !== "register") throw new HostSellerProvisioningInputError(["--yes is only for register"]);
  return { command, inputPath, yes };
}

export type HostSellerProvisioningStore = Pick<SiteSaleRegistration,
  "canProvisionHostSeller" | "currentHostSellerState" | "provisionHostSeller">;

export interface HostSellerProvisioningDependencies {
  readonly store: HostSellerProvisioningStore;
  readonly checkStripeAccount: (accountId: string) => Promise<SiteSaleAccountCheck>;
  readonly out: (line: string) => void;
}

function masked(value: string): string { return `…${value.slice(-4)}`; }

function profileOutcome(state: HostSellerProvisioningState, input: HostSellerProvisioningFile): string {
  if (!state.providerExists) return "create";
  if (state.sellerProfile === null) return "create explicit NIHO Connect mapping";
  const same = state.sellerProfile.legacyProviderId === input.provider.legacyProviderId
    && state.sellerProfile.providerDisplayName === input.provider.displayName
    && state.sellerProfile.sellerNihoAccountRef === input.seller.nihoAccountRef
    && state.sellerProfile.stripeConnectAccountRef === input.seller.stripeConnectAccountRef
    && state.sellerProfile.sellerDisplayName === input.seller.displayName;
  return same ? "unchanged" : "conflict: existing seller mapping differs";
}

/** Plans or writes seller mapping and the explicitly approved NIHO fee. It never creates a product or grants OWNER. */
export async function runHostSellerProvisioning(
  command: HostSellerProvisioningArguments["command"],
  input: HostSellerProvisioningFile,
  yes: boolean,
  deps: HostSellerProvisioningDependencies,
): Promise<number> {
  const { store, out } = deps;
  try {
    const state = await store.currentHostSellerState(input.provider.id);
    out(`Experience provider ${masked(input.provider.id)}: ${state.providerExists ? "registered" : "create"}`);
    out(`NIHO legacy Connect lookup key ${masked(input.provider.legacyProviderId)}: ${profileOutcome(state, input)}`);
    out(`NIHO seller account reference ${masked(input.seller.nihoAccountRef)}: explicitly mapped to the current identity at first login`);
    out(`Stripe connected account ${masked(input.seller.stripeConnectAccountRef)}: ${state.sellerProfile?.stripeConnectAccountRef === input.seller.stripeConnectAccountRef ? "mapped" : "map and verify"}`);
    out(`NIHO fee setting: support ${input.supportEnabled ? "on (15%)" : "off (10%)"} (${state.saleSettings === null ? "create" : state.saleSettings.supportEnabled === input.supportEnabled ? "unchanged" : "conflict: existing fee differs"})`);
    out("Product, publication, and OWNER membership: not created by this operation");
    if (command === "plan") return HOST_SELLER_PROVISIONING_EXIT.ok;
    if (!yes) {
      out("Nothing was written. Run register again with --yes to write.");
      return HOST_SELLER_PROVISIONING_EXIT.failed;
    }
    if (!await store.canProvisionHostSeller()) {
      out("This database connection cannot write seller setup (the runtime role cannot, by design). Use the migration identity.");
      return HOST_SELLER_PROVISIONING_EXIT.failed;
    }
    if (state.sellerProfile !== null && profileOutcome(state, input).startsWith("conflict:")) {
      out("Refused: existing seller mapping differs. Nothing was written.");
      return HOST_SELLER_PROVISIONING_EXIT.failed;
    }
    if (state.saleSettings !== null && state.saleSettings.supportEnabled !== input.supportEnabled) {
      out("Refused: existing NIHO fee differs. Use the reviewed fee-change process. Nothing was written.");
      return HOST_SELLER_PROVISIONING_EXIT.failed;
    }
    const stripe = await deps.checkStripeAccount(input.seller.stripeConnectAccountRef);
    if (stripe.kind !== "ready") {
      out(stripe.kind === "unreachable"
        ? "Refused: Stripe account status could not be verified. Nothing was written."
        : `Refused: Stripe account ${masked(input.seller.stripeConnectAccountRef)} is not ready for charges and payouts. Nothing was written.`);
      return HOST_SELLER_PROVISIONING_EXIT.failed;
    }
    const result = await store.provisionHostSeller({
      providerId: input.provider.id,
      legacyProviderId: input.provider.legacyProviderId,
      providerDisplayName: input.provider.displayName,
      sellerNihoAccountRef: input.seller.nihoAccountRef,
      stripeConnectAccountRef: input.seller.stripeConnectAccountRef,
      sellerDisplayName: input.seller.displayName,
      supportEnabled: input.supportEnabled,
    });
    out(`Registered: provider=${result.provider}, seller mapping=${result.sellerProfile}, fee=${result.saleSettings}.`);
    out("On first authenticated host request, Experience links OWNER only when NIHO v1 identity matches the mapped account.");
    return HOST_SELLER_PROVISIONING_EXIT.ok;
  } catch (error) {
    if (error instanceof StoreError) {
      out(`Refused: ${error.name}: ${error.message}`);
      return HOST_SELLER_PROVISIONING_EXIT.failed;
    }
    out("Unexpected failure. No credentials, identifiers, or driver details were printed.");
    return HOST_SELLER_PROVISIONING_EXIT.unexpected;
  }
}
