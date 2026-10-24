import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { EXPERIENCE_ADMIN_OPERATIONS_API_CONTRACT, EXPERIENCE_HOST_SUPPORT_HISTORY_API_CONTRACT } from "../src/contract-meta.ts";
import { generateContractTypes } from "../scripts/gen-types.ts";

async function fixed(name: string, expectedSha: string, meta: { version: string; sourceCommit: string; status: string; deploymentStatus: string }) {
  const body = await readFile(new URL(`../contract/${name}.openapi.json`, import.meta.url));
  const document = JSON.parse(body.toString("utf8"));
  const recorded = await readFile(new URL(`../contract/${name}.openapi.json.sha256`, import.meta.url), "utf8");
  const manifest = JSON.parse(await readFile(new URL(`../contract/${name}.manifest.json`, import.meta.url), "utf8"));
  expect(createHash("sha256").update(body).digest("hex")).toBe(expectedSha);
  expect(recorded.trim()).toBe(`${expectedSha}  ${name}.openapi.json`);
  expect(document.info).toMatchObject({ version: meta.version, "x-niho-contract-status": meta.status });
  expect(manifest).toMatchObject({ version: meta.version, sourceCommit: meta.sourceCommit, deploymentStatus: meta.deploymentStatus });
  return document;
}

describe("selected operations and host history contracts", () => {
  it("pins the two agreed-not-deployed exports and exact source commit", async () => {
    await fixed("experience-admin-operations-api", "fa79313ecee3ad9d1243d8d4eda6c35ec5c62c323c3cc67894ac14a448b6db30", EXPERIENCE_ADMIN_OPERATIONS_API_CONTRACT);
    await fixed("experience-host-support-history-api", "baa204de75b43b213521af2b50fd8bde4714cfdfe3f1410f4552efbafb9ea5df", EXPERIENCE_HOST_SUPPORT_HISTORY_API_CONTRACT);
  });

  it("contains only fixed Admin operations and host-owned history reads", async () => {
    const operations = await fixed("experience-admin-operations-api", "fa79313ecee3ad9d1243d8d4eda6c35ec5c62c323c3cc67894ac14a448b6db30", EXPERIENCE_ADMIN_OPERATIONS_API_CONTRACT);
    expect(Object.keys(operations.paths).sort()).toEqual([
      "/api/admin/experience-bookings/{requestId}/approve",
      "/api/admin/experience-bookings/{requestId}/cancel",
      "/api/admin/experience-bookings/{requestId}/decline",
      "/api/admin/experience-bookings/{requestId}/message",
      "/api/admin/experience-bookings/{requestId}/support-operations",
      "/api/admin/experience-bookings/{requestId}/support-operations/{operationId}",
    ]);
    const host = await fixed("experience-host-support-history-api", "baa204de75b43b213521af2b50fd8bde4714cfdfe3f1410f4552efbafb9ea5df", EXPERIENCE_HOST_SUPPORT_HISTORY_API_CONTRACT);
    expect(Object.values(host.paths as Record<string, Record<string, unknown>>).flatMap((path) => Object.keys(path))).toEqual(["get", "get"]);
    expect(JSON.stringify(host)).not.toMatch(/internalMemo|stripeId|payloadHash/i);
  });

  it("keeps generated types byte-aligned", async () => {
    expect(await readFile(new URL("../src/generated/admin-operations-openapi.ts", import.meta.url), "utf8")).toBe(await generateContractTypes("admin-operations"));
    expect(await readFile(new URL("../src/generated/host-support-history-openapi.ts", import.meta.url), "utf8")).toBe(await generateContractTypes("host-support-history"));
  });
});
