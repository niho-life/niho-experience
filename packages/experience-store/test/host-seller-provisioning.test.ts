import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import type { HostSellerProvisioningState } from "../src/site-sale-registration.ts";
import {
  HOST_SELLER_PROVISIONING_EXIT,
  HostSellerProvisioningInputError,
  parseHostSellerProvisioningArguments,
  parseHostSellerProvisioningFile,
  runHostSellerProvisioning,
  type HostSellerProvisioningFile,
  type HostSellerProvisioningStore,
} from "../src/host-seller-provisioning.ts";

const example = JSON.parse(await readFile(new URL("../../../scripts/experience/host-seller.example.json", import.meta.url), "utf8")) as Record<string, unknown>;
const INPUT = parseHostSellerProvisioningFile(example);
const EMPTY: HostSellerProvisioningState = { providerExists: false, sellerProfile: null, saleSettings: null };

function changed(edit: (input: Record<string, any>) => void): unknown {
  const copy = structuredClone(example) as Record<string, any>;
  edit(copy);
  return copy;
}

describe("host seller provisioning input", () => {
  it("accepts only provider mapping, seller identity/account, and an explicit fee setting", () => {
    assert.deepEqual(INPUT.provider, {
      id: "experience-provider-synthetic-0001",
      legacyProviderId: "niho-legacy-provider-synthetic-0001",
      displayName: "Synthetic Experience provider",
    });
    assert.equal(INPUT.seller.nihoAccountRef, "niho-account-synthetic-0001");
    assert.throws(() => parseHostSellerProvisioningFile(changed((value) => { value.product = {}; })), HostSellerProvisioningInputError);
    assert.throws(() => parseHostSellerProvisioningFile(changed((value) => { value.owner = { ownerUserId: "NIHO person" }; })), HostSellerProvisioningInputError);
    assert.throws(() => parseHostSellerProvisioningFile(changed((value) => { delete value.supportEnabled; })), HostSellerProvisioningInputError);
    assert.throws(() => parseHostSellerProvisioningFile(changed((value) => { value.provider.legacyProviderId = "unsafe/key"; })), HostSellerProvisioningInputError);
    assert.equal(parseHostSellerProvisioningFile(changed((value) => { value.seller.nihoAccountRef = "user+host@example.test"; })).seller.nihoAccountRef,
      "user+host@example.test");
  });

  it("parses dry-run and explicit write commands only", () => {
    assert.deepEqual(parseHostSellerProvisioningArguments(["input.json"]), { command: "plan", inputPath: "input.json", yes: false });
    assert.deepEqual(parseHostSellerProvisioningArguments(["register", "input.json", "--yes"]), { command: "register", inputPath: "input.json", yes: true });
    for (const argv of [[], ["register"], ["plan", "input.json", "--yes"], ["publish", "input.json"], ["register", "input.json", "--force"]]) {
      assert.throws(() => parseHostSellerProvisioningArguments(argv), HostSellerProvisioningInputError);
    }
  });
});

describe("host seller provisioning flow", () => {
  function harness(options: { canWrite?: boolean; state?: HostSellerProvisioningState; stripeReady?: boolean } = {}) {
    const calls: string[] = [];
    const lines: string[] = [];
    const store: HostSellerProvisioningStore = {
      canProvisionHostSeller: async () => { calls.push("canProvisionHostSeller"); return options.canWrite ?? true; },
      currentHostSellerState: async (providerId) => { calls.push(`current:${providerId}`); return options.state ?? EMPTY; },
      provisionHostSeller: async (input) => { calls.push(`write:${input.providerId}`); return { provider: "CREATED", sellerProfile: "CREATED", saleSettings: "CREATED" }; },
    };
    return {
      calls,
      lines,
      run: (command: "plan" | "register", yes = false) => runHostSellerProvisioning(command, INPUT, yes, {
        store,
        checkStripeAccount: async (accountId) => {
          calls.push(`stripe:${accountId}`);
          return options.stripeReady === false
            ? { kind: "not_ready", account: { idLast4: accountId.slice(-4), country: "JP", defaultCurrency: "jpy", chargesEnabled: false, payoutsEnabled: false, detailsSubmitted: false }, problems: ["not ready"] }
            : { kind: "ready", account: { idLast4: accountId.slice(-4), country: "JP", defaultCurrency: "jpy", chargesEnabled: true, payoutsEnabled: true, detailsSubmitted: true } };
        },
        out: (line) => lines.push(line),
      }),
    };
  }

  it("plans without Stripe reads or writes and never prints complete account references", async () => {
    const h = harness();
    assert.equal(await h.run("plan"), HOST_SELLER_PROVISIONING_EXIT.ok);
    assert.deepEqual(h.calls, [`current:${INPUT.provider.id}`]);
    assert.match(h.lines.join("\n"), /Product, publication, and OWNER membership: not created/);
    for (const secret of [INPUT.provider.id, INPUT.provider.legacyProviderId, INPUT.seller.nihoAccountRef, INPUT.seller.stripeConnectAccountRef]) {
      assert.equal(h.lines.join("\n").includes(secret), false);
    }
  });

  it("requires --yes, operator privileges and a ready Stripe account before writing", async () => {
    const noYes = harness();
    assert.equal(await noYes.run("register"), HOST_SELLER_PROVISIONING_EXIT.failed);
    assert.equal(noYes.calls.some((call) => call.startsWith("write:")), false);
    const runtime = harness({ canWrite: false });
    assert.equal(await runtime.run("register", true), HOST_SELLER_PROVISIONING_EXIT.failed);
    assert.equal(runtime.calls.some((call) => call.startsWith("stripe:")), false);
    const notReady = harness({ stripeReady: false });
    assert.equal(await notReady.run("register", true), HOST_SELLER_PROVISIONING_EXIT.failed);
    assert.equal(notReady.calls.some((call) => call.startsWith("write:")), false);
  });

  it("creates only the explicit seller mapping and fee after verification", async () => {
    const h = harness();
    assert.equal(await h.run("register", true), HOST_SELLER_PROVISIONING_EXIT.ok);
    assert.deepEqual(h.calls, [
      `current:${INPUT.provider.id}`, "canProvisionHostSeller", `stripe:${INPUT.seller.stripeConnectAccountRef}`, `write:${INPUT.provider.id}`,
    ]);
    assert.match(h.lines.at(-2)!, /provider=CREATED, seller mapping=CREATED, fee=CREATED/);
  });
});
