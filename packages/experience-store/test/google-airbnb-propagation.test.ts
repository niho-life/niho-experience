import assert from "node:assert/strict";
import { it } from "node:test";
import { googlePropagationJobMatches } from "../src/google-airbnb-propagation.ts";

it("keeps millisecond differences in PostgreSQL Date snapshots distinct", () => {
  const common = {
    provider_id: "provider-a", account_id: "account-a", listing_id: "listing-a", occurrence_id: "occurrence-a",
    account_version: 1, desired_version: 1, mapping_version: 1,
    source_start_at: new Date("2026-11-07T09:00:00.123Z"),
    source_end_at: new Date("2026-11-07T10:00:00.456Z"),
    target_site: "Airbnb", target_external_account_id: "123", target_external_product_id: "456",
    target_external_option_id: "", target_adapter: "airbnb-google-busy", target_adapter_version: "1",
    target_connection_mode: "GOOGLE",
  };
  const wait = { ...common, pending_job_id: "job-a", delivery_id: "delivery-a",
    dispatched_worker_id: "worker-a", dispatched_assignment_version: 1 };
  const job = { ...common, id: "job-a", google_propagation_delivery_id: "delivery-a",
    purpose: "AVAILABILITY", action: "OBSERVE", dispatch_worker_id: "worker-a", dispatch_assignment_version: 1 };
  assert.equal(googlePropagationJobMatches(wait, job), true);
  for (const key of ["source_start_at", "source_end_at"] as const) {
    assert.equal(googlePropagationJobMatches(wait, {
      ...job, [key]: new Date(common[key].getTime() + 1),
    }), false);
  }
});
