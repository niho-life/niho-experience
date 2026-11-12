import assert from "node:assert/strict";
import { inspectTranslationFixtureMemberships } from "./gcp/translate-stg-test-provider-membership.mjs";

const prefix = "stg-translate-test-";

assert.deepEqual(inspectTranslationFixtureMemberships([], prefix), { kind: "none" });
assert.deepEqual(inspectTranslationFixtureMemberships([
  { provider_id: `${prefix}active`, role: "OWNER", active: true },
], prefix), { kind: "owner", providerId: `${prefix}active` });
assert.equal(inspectTranslationFixtureMemberships([
  { provider_id: `${prefix}inactive`, role: "OWNER", active: false },
], prefix).kind, "invalid");
assert.equal(inspectTranslationFixtureMemberships([
  { provider_id: `${prefix}demoted`, role: "EDITOR", active: true },
], prefix).kind, "invalid");
assert.equal(inspectTranslationFixtureMemberships([
  { provider_id: `${prefix}multiple-a`, role: "OWNER", active: true },
  { provider_id: `${prefix}multiple-b`, role: "OWNER", active: true },
], prefix).kind, "invalid");

console.log("stg translation fixture membership policy passed");
