import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { StoreConflictError } from "../src/errors.ts";
import type { ProductSaleTerms, ProviderSaleSettings } from "../src/guest-bookings.ts";
import type { SaleReadiness, SaleReadinessKey, SiteSaleState } from "../src/site-sale-registration.ts";
import {
  SITE_SALE_EXIT,
  SiteSaleInputError,
  masked,
  parseSiteSaleArguments,
  parseSiteSaleInput,
  registerProductInput,
  runSiteSale,
  stripeKeyMode,
  type SiteSaleAccountCheck,
  type SiteSaleCommand,
  type SiteSaleInput,
  type SiteSaleStore,
} from "../src/site-sale-script.ts";
import type { ProductRecord } from "../src/types.ts";

const example = JSON.parse(await readFile(new URL("../../../scripts/experience/site-sale.example.json", import.meta.url), "utf8")) as Record<string, unknown>;
const INPUT = parseSiteSaleInput(example);
const ACCOUNT = INPUT.product.stripeConnectAccountRef;

function edited(change: (copy: Record<string, any>) => void): unknown {
  const copy = structuredClone(example) as Record<string, any>;
  change(copy);
  return copy;
}

function problemsOf(raw: unknown): readonly string[] {
  try {
    parseSiteSaleInput(raw);
  } catch (error) {
    assert.ok(error instanceof SiteSaleInputError);
    return error.problems;
  }
  assert.fail("the input was accepted");
}

/* ---------- a stub store and Stripe ---------- */

const ALL_KEYS: SaleReadinessKey[] = ["PROVIDER", "OWNER", "PRODUCT", "PUBLISHED", "UNIQUE_SLUG", "JPY", "MINIMUM_PRICE", "FEE_SETTINGS", "SALE_TERMS", "NO_CONDITIONS", "SCHEDULE"];

function readiness(failing: readonly SaleReadinessKey[], selling = false): SaleReadiness {
  return {
    providerId: INPUT.provider.id,
    productId: INPUT.product.id,
    checks: ALL_KEYS.map((key) => ({ key, ok: !failing.includes(key), detail: `${key} detail` })),
    readyToOpen: failing.every((key) => key === "SALE_TERMS" || key === "NO_CONDITIONS"),
    selling,
    futureOccurrences: failing.includes("SCHEDULE") ? 0 : 12,
  };
}

function storedProduct(overrides: Partial<ProductRecord> = {}): ProductRecord {
  return {
    ...registerProductInput(INPUT), id: INPUT.product.id, content: {}, currency: "JPY",
    version: 3, createdAtUtc: "2026-10-31T00:00:00.000Z", updatedAtUtc: "2026-10-31T00:00:00.000Z", ...overrides,
  };
}

const SETTINGS: ProviderSaleSettings = { providerId: INPUT.provider.id, supportEnabled: false, platformFeeBasisPoints: 1000, version: 2, updatedAtUtc: "2026-10-31T00:00:00.000Z" };

const EMPTY: SiteSaleState = {
  providerExists: false, membership: null, product: null, saleSettings: null, saleTerms: null,
  slugPublishedElsewhere: false, slugUsedInProvider: false, otherProductsWithSaleTerms: [],
};
const REGISTERED: SiteSaleState = {
  ...EMPTY, providerExists: true, membership: { role: "OWNER", active: true }, product: storedProduct(), saleSettings: SETTINGS,
};

interface Harness {
  readonly calls: string[];
  readonly writes: unknown[][];
  readonly lines: string[];
  readonly stripeCalls: string[];
  run(command: SiteSaleCommand, yes?: boolean, input?: SiteSaleInput): Promise<number>;
}

function harness(options: {
  state?: SiteSaleState;
  readiness?: SaleReadiness[];
  canRegister?: boolean;
  account?: SiteSaleAccountCheck;
  fail?: { method: string; error: unknown };
} = {}): Harness {
  const calls: string[] = [];
  const writes: unknown[][] = [];
  const lines: string[] = [];
  const stripeCalls: string[] = [];
  const reports = [...(options.readiness ?? [readiness(["SALE_TERMS"])])];
  const step = (method: string, args: unknown[], write: boolean) => {
    calls.push(method);
    if (write) writes.push([method, ...args]);
    if (options.fail?.method === method) throw options.fail.error;
  };
  const store: SiteSaleStore = {
    canRegister: async () => { step("canRegister", [], false); return options.canRegister ?? true; },
    currentState: async (query) => { step("currentState", [query], false); return options.state ?? EMPTY; },
    registerProvider: async (input) => { step("registerProvider", [input], true); return "CREATED"; },
    linkProviderMember: async (input) => { step("linkProviderMember", [input], true); return "CREATED"; },
    registerProduct: async (input, version) => { step("registerProduct", [input, version], true); return { product: storedProduct(), outcome: "CREATED" }; },
    setProviderSaleSettings: async (providerId, input, version) => { step("setProviderSaleSettings", [providerId, input, version], true); return SETTINGS; },
    setSaleTermsAsOperator: async (providerId, productId, terms, version) => {
      step("setSaleTermsAsOperator", [providerId, productId, terms, version], true);
      return { terms: {} as ProductSaleTerms, outcome: "CREATED" };
    },
    removeSaleTerms: async (providerId, productId) => { step("removeSaleTerms", [providerId, productId], true); return { removed: true }; },
    saleReadiness: async () => { step("saleReadiness", [], false); return reports.length > 1 ? reports.shift()! : reports[0]!; },
  };
  const account: SiteSaleAccountCheck = options.account ?? {
    kind: "ready",
    account: { idLast4: ACCOUNT.slice(-4), country: "JP", defaultCurrency: "jpy", chargesEnabled: true, payoutsEnabled: true, detailsSubmitted: true },
  };
  return {
    calls, writes, lines, stripeCalls,
    run: (command, yes = false, input = INPUT) => runSiteSale(command, input, { yes }, {
      store,
      checkStripeAccount: async (accountId) => { stripeCalls.push(accountId); return account; },
      stripeKeyMode: "test",
      out: (line) => lines.push(line),
    }),
  };
}

/** Nothing printed carries a reference in full. */
function assertMasked(lines: readonly string[]): void {
  const text = lines.join("\n");
  for (const secret of [ACCOUNT, INPUT.owner.nihoUserId, INPUT.product.sellerNihoAccountRef]) {
    assert.equal(text.includes(secret), false, `printed ${secret}`);
  }
}

describe("register-site-sale arguments (#285 slice 9)", () => {
  it("defaults to plan and takes --yes only for the write commands", () => {
    assert.deepEqual(parseSiteSaleArguments(["in.json"]), { command: "plan", inputPath: "in.json", yes: false });
    assert.deepEqual(parseSiteSaleArguments(["register", "in.json", "--yes"]), { command: "register", inputPath: "in.json", yes: true });
    assert.deepEqual(parseSiteSaleArguments(["--yes", "stop-sale", "in.json"]), { command: "stop-sale", inputPath: "in.json", yes: true });
    assert.deepEqual(parseSiteSaleArguments(["status", "in.json"]), { command: "status", inputPath: "in.json", yes: false });
    for (const argv of [[], ["register"], ["plan", "in.json", "--yes"], ["status", "in.json", "--yes"], ["regster", "in.json"], ["in.json", "more"], ["open-sale", "in.json", "--force"]]) {
      assert.throws(() => parseSiteSaleArguments(argv), SiteSaleInputError, argv.join(" "));
    }
  });
});

describe("register-site-sale input (#285 slice 9)", () => {
  it("reads the synthetic example", () => {
    assert.deepEqual(INPUT.provider, { id: "sample-provider-0001", displayName: "Sample Tea Studio" });
    assert.equal(INPUT.supportEnabled, false);
    assert.equal(INPUT.product.unitAmountYen, 4000);
    assert.equal(INPUT.saleTerms.bookingQuestions.length, 1);
    assert.equal(INPUT.saleTerms.conditionsVersion, null);
    assert.equal(registerProductInput(INPUT).status, "PUBLISHED");
  });

  it("refuses unknown and missing fields at every level", () => {
    assert.deepEqual(problemsOf(edited((copy) => { copy.extra = 1; })), ["input.extra is not a known field"]);
    assert.deepEqual(problemsOf(edited((copy) => { delete copy.owner; })), ["input.owner is missing", "owner must be an object"]);
    assert.deepEqual(problemsOf(edited((copy) => { copy.product.price = 1; })), ["product.price is not a known field"]);
    assert.deepEqual(problemsOf(edited((copy) => { copy.saleTerms.childPricing.note = "x"; })), ["saleTerms.childPricing.note is not a known field"]);
    assert.deepEqual(problemsOf(edited((copy) => { copy.saleTerms.bookingQuestions[0].options[0].hint = "x"; })), ["saleTerms.bookingQuestions.0.options.0.hint is not a known field"]);
    assert.deepEqual(problemsOf([]), ["input must be an object"]);
  });

  it("names the field and the rule, never the value", () => {
    const value = "acct-NOT-AN-ACCOUNT-sample-9999";
    const problems = problemsOf(edited((copy) => {
      copy.provider.id = "sample provider";
      copy.owner.nihoUserId = "";
      copy.supportEnabled = "no";
      copy.product.slug = "Sample_Tea";
      copy.product.unitAmountYen = 49;
      copy.product.stripeConnectAccountRef = value;
      copy.product.title = " padded ";
    }));
    assert.deepEqual(problems.map((problem) => problem.split(" ")[0]), [
      "supportEnabled", "provider.id", "owner.nihoUserId", "product.unitAmountYen", "product.slug", "product.title", "product.stripeConnectAccountRef",
    ]);
    assert.equal(problems.join("\n").includes(value), false);
  });

  it("uses setSaleTerms' validation and refuses participation conditions this site cannot show", () => {
    assert.deepEqual(problemsOf(edited((copy) => { copy.saleTerms.conditionsVersion = "c0".repeat(32); })),
      ["saleTerms.conditionsVersion must be null (this site cannot show participation conditions yet)"]);
    assert.deepEqual(problemsOf(edited((copy) => { copy.saleTerms.maxPartySize = 0; })), ["saleTerms: maxPartySize must be an integer from 1 to 500."]);
    assert.deepEqual(problemsOf(edited((copy) => { copy.saleTerms.cancellationPolicy = "FLEXIBLE"; })), ["saleTerms: cancellationPolicy is invalid."]);
  });
});

describe("register-site-sale flow (#285 slice 9)", () => {
  it("plan reads only, shows the changes and the readiness with references masked", async () => {
    const h = harness({ state: { ...REGISTERED, product: storedProduct({ unitAmount: 3500, stripeConnectAccountRef: "acct_SampleSellerOld9" }), otherProductsWithSaleTerms: ["sample-walk"] } });
    assert.equal(await h.run("plan"), SITE_SALE_EXIT.ok);
    assert.deepEqual(h.writes, []);
    assert.deepEqual(h.stripeCalls, []);
    const text = h.lines.join("\n");
    assert.match(text, /price ¥3,500 → ¥4,000/);
    assert.match(text, /stripeConnectAccountRef …Old9 → …0001/);
    assert.match(text, /other products of the provider have sale terms \(sample-walk\): a fee change applies to them too/);
    assert.match(text, /\[--\] SALE_TERMS: SALE_TERMS detail/);
    assertMasked(h.lines);
  });

  it("status shows the readiness only", async () => {
    const h = harness();
    assert.equal(await h.run("status"), SITE_SALE_EXIT.ok);
    assert.deepEqual(h.calls, ["saleReadiness"]);
  });

  it("writes nothing without --yes or with a connection that cannot register", async () => {
    for (const command of ["register", "open-sale", "stop-sale"] as const) {
      const h = harness({ state: REGISTERED });
      assert.equal(await h.run(command), SITE_SALE_EXIT.failed);
      assert.deepEqual(h.writes, []);
      assert.match(h.lines.at(-1)!, /Nothing was written/);
      const runtime = harness({ state: REGISTERED, canRegister: false });
      assert.equal(await runtime.run(command, true), SITE_SALE_EXIT.failed);
      assert.deepEqual(runtime.writes, []);
      assert.deepEqual(runtime.stripeCalls, []);
    }
  });

  it("register checks the Stripe account, then writes the provider, the OWNER, the product and the fee, never the sale terms", async () => {
    const h = harness();
    assert.equal(await h.run("register", true), SITE_SALE_EXIT.ok);
    assert.deepEqual(h.stripeCalls, [ACCOUNT]);
    assert.deepEqual(h.writes, [
      ["registerProvider", { providerId: INPUT.provider.id }],
      ["linkProviderMember", { providerId: INPUT.provider.id, nihoUserId: INPUT.owner.nihoUserId, role: "OWNER" }],
      ["registerProduct", registerProductInput(INPUT), undefined],
      ["setProviderSaleSettings", INPUT.provider.id, { supportEnabled: false }, undefined],
    ]);
    assert.match(h.lines.join("\n"), /Stripe account …0001 \(test key\): country JP, default currency jpy, charges on, payouts on, details submitted/);
    assertMasked(h.lines);
  });

  it("register updates at the versions it read, and leaves an unchanged fee alone", async () => {
    const changedFee = harness({ state: { ...REGISTERED, saleSettings: { ...SETTINGS, supportEnabled: true, platformFeeBasisPoints: 1500 } } });
    assert.equal(await changedFee.run("register", true), SITE_SALE_EXIT.ok);
    assert.deepEqual(changedFee.writes.slice(2), [
      ["registerProduct", registerProductInput(INPUT), 3],
      ["setProviderSaleSettings", INPUT.provider.id, { supportEnabled: false }, 2],
    ]);
    const same = harness({ state: REGISTERED });
    assert.equal(await same.run("register", true), SITE_SALE_EXIT.ok);
    assert.equal(same.writes.some(([method]) => method === "setProviderSaleSettings"), false);
  });

  it("register refuses a taken slug or an account that cannot take charges, before writing", async () => {
    for (const state of [{ ...EMPTY, slugPublishedElsewhere: true }, { ...EMPTY, slugUsedInProvider: true }]) {
      const h = harness({ state });
      assert.equal(await h.run("register", true), SITE_SALE_EXIT.failed);
      assert.deepEqual([h.writes, h.stripeCalls], [[], []]);
    }
    const summary = { idLast4: "0001", country: "JP", defaultCurrency: "jpy", chargesEnabled: false, payoutsEnabled: true, detailsSubmitted: false };
    const notReady = harness({ account: { kind: "not_ready", account: summary, problems: ["CHARGES_DISABLED", "DETAILS_NOT_SUBMITTED"] } });
    assert.equal(await notReady.run("register", true), SITE_SALE_EXIT.failed);
    assert.deepEqual(notReady.writes, []);
    assert.match(notReady.lines.join("\n"), /not ready: CHARGES_DISABLED, DETAILS_NOT_SUBMITTED/);
    const unreachable = harness({ account: { kind: "unreachable" } });
    assert.equal(await unreachable.run("register", true), SITE_SALE_EXIT.failed);
    assert.deepEqual(unreachable.writes, []);
    assertMasked(unreachable.lines);
  });

  it("open-sale needs the registration as the input says and every check but the terms", async () => {
    const unregistered = harness({ state: { ...REGISTERED, saleSettings: { ...SETTINGS, supportEnabled: true } } });
    assert.equal(await unregistered.run("open-sale", true), SITE_SALE_EXIT.failed);
    assert.match(unregistered.lines.at(-1)!, /run register first \(NIHO's fee setting differs from the input\)/);
    assert.deepEqual([unregistered.writes, unregistered.stripeCalls], [[], []]);

    const notReady = harness({ state: REGISTERED, readiness: [readiness(["SALE_TERMS", "SCHEDULE"])] });
    assert.equal(await notReady.run("open-sale", true), SITE_SALE_EXIT.failed);
    assert.match(notReady.lines.at(-1)!, /not ready to open \(SCHEDULE\)/);
    assert.deepEqual([notReady.writes, notReady.stripeCalls], [[], []]);

    const badAccount = harness({ state: REGISTERED, account: { kind: "unreachable" } });
    assert.equal(await badAccount.run("open-sale", true), SITE_SALE_EXIT.failed);
    assert.deepEqual(badAccount.writes, []);
  });

  it("open-sale re-checks the stored Stripe account, writes the terms at the version read and confirms the sale", async () => {
    const terms = { version: 4 } as ProductSaleTerms;
    const h = harness({ state: { ...REGISTERED, saleTerms: terms }, readiness: [readiness(["SALE_TERMS"]), readiness([], true)] });
    assert.equal(await h.run("open-sale", true), SITE_SALE_EXIT.ok);
    assert.deepEqual(h.stripeCalls, [REGISTERED.product!.stripeConnectAccountRef]);
    assert.deepEqual(h.writes, [["setSaleTermsAsOperator", INPUT.provider.id, INPUT.product.id, INPUT.saleTerms, 4]]);
    assert.match(h.lines.at(-1)!, /The sale is open on this site/);

    const notSold = harness({ state: REGISTERED, readiness: [readiness(["SALE_TERMS"]), readiness(["UNIQUE_SLUG"], false)] });
    assert.equal(await notSold.run("open-sale", true), SITE_SALE_EXIT.failed);
    assert.match(notSold.lines.at(-1)!, /written but the product is not sold here/);
  });

  it("stop-sale removes the terms and checks the product is no longer sold", async () => {
    const h = harness({ state: REGISTERED, readiness: [readiness(["SALE_TERMS"])] });
    assert.equal(await h.run("stop-sale", true), SITE_SALE_EXIT.ok);
    assert.deepEqual(h.writes, [["removeSaleTerms", INPUT.provider.id, INPUT.product.id]]);
    assert.deepEqual(h.stripeCalls, []);
    assert.match(h.lines.join("\n"), /Sale terms: removed/);
  });

  it("reports a store refusal as 1 and anything else as 2 without its message", async () => {
    const conflict = harness({ state: REGISTERED, fail: { method: "registerProduct", error: new StoreConflictError("Product version mismatch: read the product again.") } });
    assert.equal(await conflict.run("register", true), SITE_SALE_EXIT.failed);
    assert.match(conflict.lines.at(-1)!, /Refused: StoreConflictError: Product version mismatch/);
    const leak = Object.assign(new Error("connection to postgresql://operator:synthetic-password@db failed"), { code: "ECONNREFUSED" });
    const unexpected = harness({ fail: { method: "currentState", error: leak } });
    assert.equal(await unexpected.run("plan"), SITE_SALE_EXIT.unexpected);
    assert.equal(unexpected.lines.join("\n").includes("synthetic-password"), false);
    assert.match(unexpected.lines.at(-1)!, /Unexpected failure: Error \(ECONNREFUSED\)/);
  });

  it("names the key's mode from its prefix and masks references to the last 4", () => {
    assert.equal(stripeKeyMode("sk_test_synthetic"), "test");
    assert.equal(stripeKeyMode("rk_live_synthetic"), "live");
    assert.equal(stripeKeyMode("whsec_synthetic"), "unknown");
    assert.equal(stripeKeyMode(undefined), "unknown");
    assert.equal(masked("acct_SampleSeller0001"), "…0001");
  });
});
