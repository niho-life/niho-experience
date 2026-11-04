import { StoreError } from "./errors.ts";
import type {
  RegisterProductInput,
  RegistrationOutcome,
  SaleReadiness,
  SiteSaleRegistration,
  SiteSaleState,
} from "./site-sale-registration.ts";
import type { ProductRecord } from "./types.ts";

/*
 * The operator's seller workspace bootstrap (#285 slice 9): input validation and the command flow of
 * scripts/experience/register-site-sale.mjs. The store and the Stripe check are passed in; nothing here
 * reads the environment, a file, the network or the database. Output is plain English lines with no
 * secret: the Stripe account, the NIHO user and the seller's NIHO account show their last 4 characters only.
 */

export const SITE_SALE_COMMANDS = ["plan", "register", "status"] as const;
export type SiteSaleCommand = (typeof SITE_SALE_COMMANDS)[number];
const WRITE_COMMANDS: ReadonlySet<SiteSaleCommand> = new Set(["register"]);

export const SITE_SALE_EXIT = { ok: 0, failed: 1, unexpected: 2 } as const;
export type SiteSaleExitCode = (typeof SITE_SALE_EXIT)[keyof typeof SITE_SALE_EXIT];

export const SITE_SALE_USAGE =
  "Usage: node scripts/experience/register-site-sale.mjs [plan|register|status] <input.json> [--yes]";

/** NIHO's provider IDs as /host takes them in ?providerId= (apps/web/src/lib/host/providers.ts). */
const NIHO_PROVIDER_ID = /^[A-Za-z0-9_-]{1,64}$/;
/** A store identifier no longer than the host session keeps a NIHO user ID (128). */
const NIHO_USER_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;
/** A store identifier that fits the guest idempotency key (120). */
const PRODUCT_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,119}$/;
/** The public URL slug (the same rule as the site's other slugs), at most 160 characters. */
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const CONNECTED_ACCOUNT_ID = /^acct_[A-Za-z0-9]{8,250}$/;
const CONTROL = /[\u0000-\u001F\u007F]/;
const MINIMUM_CHARGE_YEN = 50;
const MAXIMUM_AMOUNT = 9_999_999_999;

export class SiteSaleInputError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`The input is invalid: ${problems.join("; ")}`);
    this.name = "SiteSaleInputError";
    this.problems = problems;
  }
}

export interface SiteSaleInput {
  readonly provider: { readonly id: string; readonly displayName: string };
  readonly owner: { readonly nihoUserId: string };
  /** NIHO support: on is a 15% fee, off 10% (provider_sale_settings). */
  readonly supportEnabled: boolean;
  readonly product: {
    readonly id: string;
    readonly slug: string;
    readonly title: string;
    readonly unitAmountYen: number;
    readonly cancellationTermsRef: string;
    readonly sellerNihoAccountRef: string;
    readonly stripeConnectAccountRef: string;
    readonly sellerDisplayName: string;
  };
}

export interface SiteSaleArguments {
  readonly command: SiteSaleCommand;
  readonly inputPath: string;
  readonly yes: boolean;
}

/** `[command] <input.json> [--yes]`; the command defaults to plan. */
export function parseSiteSaleArguments(argv: readonly string[]): SiteSaleArguments {
  const yes = argv.includes("--yes");
  const rest = argv.filter((value) => value !== "--yes");
  const unknownFlag = rest.find((value) => value.startsWith("-"));
  if (unknownFlag !== undefined) throw new SiteSaleInputError(["unknown option (only --yes is accepted)"]);
  const [first, second, ...extra] = rest;
  if (first === "open-sale" || first === "stop-sale") {
    throw new SiteSaleInputError(["public listings can only be published or stopped by the OWNER through the authenticated host API"]);
  }
  const named = SITE_SALE_COMMANDS.find((command) => command === first);
  const command: SiteSaleCommand = named ?? "plan";
  const inputPath = named === undefined ? first : second;
  if (inputPath === undefined || inputPath.length === 0) throw new SiteSaleInputError(["the input file path is missing"]);
  if ((named === undefined ? second : extra[0]) !== undefined) throw new SiteSaleInputError(["unknown command or extra arguments"]);
  if (yes && !WRITE_COMMANDS.has(command)) throw new SiteSaleInputError(["--yes is only for register"]);
  return { command, inputPath, yes };
}

/* ---------- the input ---------- */

type Json = Record<string, unknown>;

function objectAt(value: unknown, path: string, keys: readonly string[], problems: string[], requiredKeys: readonly string[] = keys): Json | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    problems.push(`${path} must be an object`);
    return null;
  }
  const record = value as Json;
  for (const key of Object.keys(record)) if (!keys.includes(key)) problems.push(`${path}.${key} is not a known field`);
  for (const key of requiredKeys) if (!(key in record)) problems.push(`${path}.${key} is missing`);
  return record;
}

function textAt(value: unknown, path: string, max: number, problems: string[]): string {
  if (typeof value !== "string" || CONTROL.test(value) || value.trim() !== value || value.length < 1 || value.length > max) {
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

/**
 * The registration file, strictly: every field present, no unknown field, and every value the shape the
 * store and the site need. Errors name the field and the rule, never the value.
 */
export function parseSiteSaleInput(raw: unknown): SiteSaleInput {
  const problems: string[] = [];
  const root = objectAt(raw, "input", ["provider", "owner", "supportEnabled", "product"], problems);
  if (root === null) throw new SiteSaleInputError(problems);
  const provider = objectAt(root.provider, "provider", ["id", "displayName"], problems);
  const owner = objectAt(root.owner, "owner", ["nihoUserId"], problems);
  const product = objectAt(root.product, "product", [
    "id", "slug", "title", "unitAmountYen", "cancellationTermsRef", "sellerNihoAccountRef", "stripeConnectAccountRef", "sellerDisplayName",
  ], problems);
  if (typeof root.supportEnabled !== "boolean") problems.push("supportEnabled must be true or false");
  const providerId = provider ? patternAt(provider.id, "provider.id", NIHO_PROVIDER_ID, "NIHO's provider ID (1-64 letters, digits, _ or -)", problems) : "";
  const displayName = provider ? textAt(provider.displayName, "provider.displayName", 300, problems) : "";
  const nihoUserId = owner ? patternAt(owner.nihoUserId, "owner.nihoUserId", NIHO_USER_ID, "a NIHO user ID (1-128 letters, digits or ._:@/-)", problems) : "";
  let unitAmountYen = 0;
  if (product) {
    const amount = product.unitAmountYen;
    if (typeof amount !== "number" || !Number.isSafeInteger(amount) || (amount !== 0 && amount < MINIMUM_CHARGE_YEN) || amount > MAXIMUM_AMOUNT) {
      problems.push(`product.unitAmountYen must be ¥0 or at least ${MINIMUM_CHARGE_YEN} (Stripe's smallest charge)`);
    } else {
      unitAmountYen = amount;
    }
    if (typeof product.slug !== "string" || product.slug.length > 160 || !SLUG.test(product.slug)) {
      problems.push("product.slug must be the page's slug: lowercase letters and digits joined by single hyphens, at most 160 characters");
    }
  }
  const parsedProduct = product === null ? null : {
    id: patternAt(product.id, "product.id", PRODUCT_ID, "a product ID of 1-120 letters, digits or ._:@/-", problems),
    slug: typeof product.slug === "string" ? product.slug : "",
    title: textAt(product.title, "product.title", 300, problems),
    unitAmountYen,
    cancellationTermsRef: textAt(product.cancellationTermsRef, "product.cancellationTermsRef", 512, problems),
    sellerNihoAccountRef: textAt(product.sellerNihoAccountRef, "product.sellerNihoAccountRef", 256, problems),
    stripeConnectAccountRef: patternAt(product.stripeConnectAccountRef, "product.stripeConnectAccountRef", CONNECTED_ACCOUNT_ID, "a Stripe connected account ID (acct_…)", problems),
    sellerDisplayName: textAt(product.sellerDisplayName, "product.sellerDisplayName", 300, problems),
  };
  if (problems.length > 0 || parsedProduct === null) throw new SiteSaleInputError(problems.length > 0 ? problems : ["the input is incomplete"]);
  return {
    provider: { id: providerId, displayName },
    owner: { nihoUserId },
    supportEnabled: root.supportEnabled as boolean,
    product: parsedProduct,
  };
}

/* ---------- the flow ---------- */

/** The store's operator methods the flow uses (SiteSaleRegistration). */
export type SiteSaleStore = Pick<
  SiteSaleRegistration,
  | "canRegister"
  | "currentState"
  | "registerProvider"
  | "linkProviderMember"
  | "registerProduct"
  | "setProviderSaleSettings"
  | "saleReadiness"
>;

/** experience-payments' retrieveConnectedAccount answer (the same shape; this package does not import payments). */
export type SiteSaleAccountCheck =
  | { readonly kind: "ready"; readonly account: SiteSaleAccountSummary }
  | { readonly kind: "not_ready"; readonly account: SiteSaleAccountSummary; readonly problems: readonly string[] }
  | { readonly kind: "unreachable" };

export interface SiteSaleAccountSummary {
  readonly idLast4: string;
  readonly country: string | null;
  readonly defaultCurrency: string | null;
  readonly chargesEnabled: boolean;
  readonly payoutsEnabled: boolean;
  readonly detailsSubmitted: boolean;
}

export interface SiteSaleDependencies {
  readonly store: SiteSaleStore;
  /** Reads the connected account with the experience platform key; register calls it before writing. */
  readonly checkStripeAccount: (accountId: string) => Promise<SiteSaleAccountCheck>;
  /** "test", "live" or "unknown", from the key's prefix (stripeKeyMode); printed next to the account check. */
  readonly stripeKeyMode?: string;
  readonly out: (line: string) => void;
}

/** The mode of a Stripe secret or restricted key, from its prefix only (the key itself is never printed). */
export function stripeKeyMode(key: string | undefined): "test" | "live" | "unknown" {
  if (typeof key !== "string") return "unknown";
  if (/^(sk|rk)_test_/.test(key)) return "test";
  if (/^(sk|rk)_live_/.test(key)) return "live";
  return "unknown";
}

/** The last 4 characters only. */
export function masked(value: string): string {
  return `…${value.slice(-4)}`;
}

function yen(amount: number): string {
  return `¥${amount.toLocaleString("en-US")}`;
}

function supportLabel(enabled: boolean): string {
  return enabled ? "support on (15%)" : "support off (10%)";
}

export function registerProductInput(input: SiteSaleInput): RegisterProductInput {
  return {
    providerId: input.provider.id,
    productId: input.product.id,
    slug: input.product.slug,
    // Sold here only while it is the one PUBLISHED product with the slug; its sale terms open the sale.
    status: "PUBLISHED",
    publicTitle: input.product.title,
    unitAmount: input.product.unitAmountYen,
    cancellationTermsRef: input.product.cancellationTermsRef,
    sellerNihoAccountRef: input.product.sellerNihoAccountRef,
    stripeConnectAccountRef: input.product.stripeConnectAccountRef,
    sellerDisplayName: input.product.sellerDisplayName,
  };
}

/** What register would change in the product, field by field (references masked). Empty when it is the same. */
export function productChanges(current: ProductRecord, input: SiteSaleInput): string[] {
  const next = registerProductInput(input);
  const changes: string[] = [];
  const plain = (name: string, before: string, after: string) => { if (before !== after) changes.push(`${name} ${before} → ${after}`); };
  const hidden = (name: string, before: string, after: string) => { if (before !== after) changes.push(`${name} ${masked(before)} → ${masked(after)}`); };
  plain("slug", current.slug, next.slug);
  plain("status", current.status, next.status);
  plain("title", JSON.stringify(current.publicTitle), JSON.stringify(next.publicTitle));
  plain("currency", current.currency, "JPY");
  if (current.unitAmount !== next.unitAmount) changes.push(`price ${yen(current.unitAmount)} → ${yen(next.unitAmount)}`);
  plain("cancellationTermsRef", current.cancellationTermsRef, next.cancellationTermsRef);
  hidden("sellerNihoAccountRef", current.sellerNihoAccountRef, next.sellerNihoAccountRef);
  hidden("stripeConnectAccountRef", current.stripeConnectAccountRef, next.stripeConnectAccountRef);
  plain("sellerDisplayName", JSON.stringify(current.sellerDisplayName), JSON.stringify(next.sellerDisplayName));
  return changes;
}

function printPlan(state: SiteSaleState, input: SiteSaleInput, out: (line: string) => void): void {
  const { provider, owner, product } = input;
  out(`Provider ${provider.id} (${provider.displayName}): ${state.providerExists ? "registered" : "register"}`);
  const member = state.membership;
  const ownerAction = member === null ? "link as OWNER"
    : member.role !== "OWNER" ? `change role ${member.role} → OWNER${member.active ? "" : " and reactivate"}`
      : member.active ? "linked as OWNER" : "reactivate as OWNER";
  out(`Owner NIHO user ${masked(owner.nihoUserId)}: ${ownerAction}`);
  if (state.product === null) {
    out(`Product ${product.id} (slug ${product.slug}): register as PUBLISHED, ${yen(product.unitAmountYen)}, Stripe account ${masked(product.stripeConnectAccountRef)}`);
  } else {
    const changes = productChanges(state.product, input);
    out(`Product ${product.id} (slug ${product.slug}): ${changes.length === 0 ? "registered, unchanged" : `update ${changes.join("; ")}`}`);
  }
  const settings = state.saleSettings;
  out(`NIHO's fee: ${settings === null ? `set ${supportLabel(input.supportEnabled)}`
    : settings.supportEnabled === input.supportEnabled ? `${supportLabel(settings.supportEnabled)}, unchanged`
      : `change ${supportLabel(settings.supportEnabled)} → ${supportLabel(input.supportEnabled)} (for every product of the provider, from the next booking)`}`);
  const terms = state.saleTerms;
  out(`Sale terms: ${terms === null ? "not configured" : "configured; editable only by the OWNER through the host API"}`);
  if (state.slugUsedInProvider) out("WARNING: another product of this provider uses this slug; register refuses it.");
  else if (state.slugPublishedElsewhere) out("WARNING: another provider already publishes this slug; register refuses it (both would stop selling).");
  if (state.otherProductsWithSaleTerms.length > 0) {
    const note = settings === null ? "a fee setting applies to their next checkout if published" : "a fee change applies to their next checkout too";
    out(`WARNING: other products of the provider have sale terms (${state.otherProductsWithSaleTerms.join(", ")}): ${note}.`);
  }
}

function printReadiness(readiness: SaleReadiness, out: (line: string) => void): void {
  out(`Readiness of ${readiness.providerId} / ${readiness.productId}:`);
  for (const check of readiness.checks) out(`  [${check.ok ? "ok" : "--"}] ${check.key}: ${check.detail}`);
  out(`  prerequisites for OWNER publication: ${readiness.readyToOpen ? "yes" : "no"}; publicly listed now: ${readiness.selling ? "yes" : "no"}`);
}

/** Checks the seller's account; prints its summary. True when it can take this site's JPY charges. */
async function accountReady(accountId: string, deps: SiteSaleDependencies): Promise<boolean> {
  const mode = deps.stripeKeyMode ?? "unknown";
  const check = await deps.checkStripeAccount(accountId);
  if (check.kind === "unreachable") {
    deps.out(`Stripe account ${masked(accountId)} (${mode} key): not visible to the platform key (not connected to this platform, or the key cannot read connected accounts).`);
    return false;
  }
  const a = check.account;
  deps.out(`Stripe account …${a.idLast4} (${mode} key): country ${a.country ?? "unknown"}, default currency ${a.defaultCurrency ?? "unknown"}, `
    + `charges ${a.chargesEnabled ? "on" : "off"}, payouts ${a.payoutsEnabled ? "on" : "off"}, details ${a.detailsSubmitted ? "submitted" : "not submitted"}.`);
  if (check.kind === "not_ready") {
    deps.out(`Stripe account not ready: ${check.problems.join(", ")}.`);
    return false;
  }
  return true;
}

function outcomeLine(what: string, outcome: RegistrationOutcome): string {
  return `${what}: ${outcome.toLowerCase()}`;
}

/** A name and code safe to print: never the message, which may repeat a value or a connection detail. */
export function safeErrorLabel(error: unknown): string {
  const name = (error as { name?: unknown } | null)?.name;
  const code = (error as { code?: unknown } | null)?.code;
  const type = (error as { type?: unknown } | null)?.type;
  const label = typeof name === "string" && /^[A-Za-z]{1,60}$/.test(name) ? name : "Error";
  const detail = [type, code].filter((value): value is string => typeof value === "string" && /^[A-Za-z0-9_]{1,60}$/.test(value));
  return detail.length > 0 ? `${label} (${detail.join(", ")})` : label;
}

/**
 * Runs one command and returns the exit code: 0 done, 1 refused (input, readiness, the Stripe account, a
 * missing --yes, a conflict), 2 unexpected. plan (read only) shows the registration and readiness;
 * register writes the provider, OWNER, product and NIHO's fee. Public listing is controlled by the OWNER
 * through the authenticated host API; this operator bootstrap cannot publish or stop a listing.
 */
export async function runSiteSale(
  command: SiteSaleCommand,
  input: SiteSaleInput,
  options: { readonly yes: boolean },
  deps: SiteSaleDependencies,
): Promise<SiteSaleExitCode> {
  const { store, out } = deps;
  const providerId = input.provider.id;
  const productId = input.product.id;
  try {
    if (command === "status") {
      printReadiness(await store.saleReadiness(providerId, productId), out);
      return SITE_SALE_EXIT.ok;
    }
    const state = await store.currentState({ providerId, productId, nihoUserId: input.owner.nihoUserId, slug: input.product.slug });
    out(`Plan (${command}):`);
    printPlan(state, input, out);
    if (command === "plan") {
      printReadiness(await store.saleReadiness(providerId, productId), out);
      return SITE_SALE_EXIT.ok;
    }
    if (!options.yes) {
      out(`Nothing was written. Run ${command} again with --yes to write.`);
      return SITE_SALE_EXIT.failed;
    }
    if (!await store.canRegister()) {
      out("This database connection cannot write the registration (the runtime role cannot, by design). "
        + "Connect with the migration identity (docs/guest-booking.md 「体験の登録と切替（第9段）」).");
      return SITE_SALE_EXIT.failed;
    }
    return await register(state, input, deps);
  } catch (error) {
    if (error instanceof StoreError) {
      // Store messages are fixed sentences that name fields, never values.
      out(`Refused: ${error.name}: ${error.message}`);
      return SITE_SALE_EXIT.failed;
    }
    out(`Unexpected failure: ${safeErrorLabel(error)}. Only the steps printed above as done were written.`);
    return SITE_SALE_EXIT.unexpected;
  }
}

async function register(state: SiteSaleState, input: SiteSaleInput, deps: SiteSaleDependencies): Promise<SiteSaleExitCode> {
  const { store, out } = deps;
  if (state.slugPublishedElsewhere || state.slugUsedInProvider) {
    out("Refused: the slug is taken (see the warning above). Nothing was written.");
    return SITE_SALE_EXIT.failed;
  }
  if (!await accountReady(input.product.stripeConnectAccountRef, deps)) {
    out("Refused: the seller's Stripe account cannot take this site's charges yet. Nothing was written.");
    return SITE_SALE_EXIT.failed;
  }
  const providerId = input.provider.id;
  out(outcomeLine("Provider", await store.registerProvider({ providerId })));
  out(outcomeLine("Owner", await store.linkProviderMember({ providerId, nihoUserId: input.owner.nihoUserId, role: "OWNER" })));
  const product = await store.registerProduct(registerProductInput(input), state.product?.version);
  out(outcomeLine("Product", product.outcome));
  const settings = state.saleSettings;
  if (settings === null) {
    await store.setProviderSaleSettings(providerId, { supportEnabled: input.supportEnabled });
    out(outcomeLine("NIHO's fee", "CREATED"));
  } else if (settings.supportEnabled !== input.supportEnabled) {
    await store.setProviderSaleSettings(providerId, { supportEnabled: input.supportEnabled }, settings.version);
    out(outcomeLine("NIHO's fee", "UPDATED"));
  } else {
    out(outcomeLine("NIHO's fee", "UNCHANGED"));
  }
  const readiness = await store.saleReadiness(providerId, input.product.id);
  printReadiness(readiness, out);
  if (readiness.selling) {
    out("Registered. An OWNER publication is already active; do not sell the same dates on NIHO.");
  } else {
    out("Registered. The OWNER must finish and publish this product through the authenticated host API before it can be booked.");
  }
  return SITE_SALE_EXIT.ok;
}
