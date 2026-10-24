import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { EXPERIENCE_FEE_SUMMARY_API_CONTRACT } from "../src/contract-meta.ts";
import { generateContractTypes } from "../scripts/gen-types.ts";

describe("selected Experience fee summary contract", () => {
  it("pins the exact agreed-not-deployed export and source commit", async () => {
    const body = await readFile(new URL("../contract/experience-fee-summary-api.openapi.json", import.meta.url));
    const recorded = await readFile(new URL("../contract/experience-fee-summary-api.openapi.json.sha256", import.meta.url), "utf8");
    const manifest = JSON.parse(await readFile(new URL("../contract/experience-fee-summary-api.manifest.json", import.meta.url), "utf8"));
    const document = JSON.parse(body.toString("utf8"));
    expect(createHash("sha256").update(body).digest("hex")).toBe(EXPERIENCE_FEE_SUMMARY_API_CONTRACT.sha256);
    expect(recorded.trim()).toBe(`${EXPERIENCE_FEE_SUMMARY_API_CONTRACT.sha256}  experience-fee-summary-api.openapi.json`);
    expect(document.info).toMatchObject({ version: EXPERIENCE_FEE_SUMMARY_API_CONTRACT.version, "x-niho-contract-status": EXPERIENCE_FEE_SUMMARY_API_CONTRACT.status });
    expect(manifest).toMatchObject({
      version: EXPERIENCE_FEE_SUMMARY_API_CONTRACT.version,
      sourceCommit: EXPERIENCE_FEE_SUMMARY_API_CONTRACT.sourceCommit,
      jsonSha256: EXPERIENCE_FEE_SUMMARY_API_CONTRACT.sha256,
      deploymentStatus: EXPERIENCE_FEE_SUMMARY_API_CONTRACT.deploymentStatus,
    });
  });

  it("contains only the two fixed GET reads and no private identifiers", async () => {
    const document = JSON.parse(await readFile(new URL("../contract/experience-fee-summary-api.openapi.json", import.meta.url), "utf8"));
    expect(Object.keys(document.paths).sort()).toEqual([
      "/api/admin/experience-bookings/{requestId}/fee-summary",
      "/api/experience-providers/management/bookings/{requestId}/fee-summary",
    ]);
    expect(Object.values(document.paths as Record<string, Record<string, unknown>>).flatMap((path) => Object.keys(path))).toEqual(["get", "get"]);
    expect(JSON.stringify(document)).not.toMatch(/stripeId|paymentIntent|chargeId|customerEmail|payloadHash/i);
  });

  it("keeps generated types byte-aligned", async () => {
    expect(await readFile(new URL("../src/generated/fee-summary-openapi.ts", import.meta.url), "utf8")).toBe(await generateContractTypes("fee-summary"));
  });
});
