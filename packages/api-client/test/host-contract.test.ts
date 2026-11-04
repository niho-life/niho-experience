import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { EXPERIENCE_HOST_API_CONTRACT } from "../src/contract-meta.ts";
import { generateContractTypes } from "../scripts/gen-types.ts";

type Document = {
  info: { version: string; "x-niho-contract-status"?: string };
  paths: Record<string, Record<string, { operationId?: string }>>;
};

describe("NIHO Experience host common contract v1.0.0", () => {
  it("pins NIHO #19712 export bytes, source commit, hash and generated types", async () => {
    const body = await readFile(new URL("../contract/experience-host-api.openapi.json", import.meta.url));
    const document = JSON.parse(body.toString("utf8")) as Document;
    const hash = createHash("sha256").update(body).digest("hex");
    const recorded = await readFile(new URL("../contract/experience-host-api.openapi.json.sha256", import.meta.url), "utf8");

    expect(recorded.trim()).toBe(`${hash}  experience-host-api.openapi.json`);
    expect(hash).toBe(EXPERIENCE_HOST_API_CONTRACT.sha256);
    expect(document.info.version).toBe("1.0.0");
    expect(document.info.version).toBe(EXPERIENCE_HOST_API_CONTRACT.version);
    expect(document.info["x-niho-contract-status"]).toBe(EXPERIENCE_HOST_API_CONTRACT.status);
    expect(EXPERIENCE_HOST_API_CONTRACT.sourceCommit).toBe("b5b664e6bfcb0bc8d0be01ffa109a684647b17db");
    expect(EXPERIENCE_HOST_API_CONTRACT.deploymentStatus).toBe("not-deployed");
    expect(await readFile(new URL("../src/generated/host-openapi.ts", import.meta.url), "utf8")).toBe(await generateContractTypes("host"));
  });

  it("keeps provider listing, seller writes and Connect mutations outside the selected contract", async () => {
    const body = await readFile(new URL("../contract/experience-host-api.openapi.json", import.meta.url));
    const document = JSON.parse(body.toString("utf8")) as Document;
    const operations = Object.entries(document.paths).flatMap(([path, methods]) => Object.entries(methods)
      .filter(([method]) => method !== "parameters")
      .map(([method, operation]) => `${method.toUpperCase()} ${path} ${operation.operationId}`)).sort();
    expect(operations).toEqual([
      "DELETE /api/auth/app-connections/{connectionId} deleteAuthAppConnection",
      "GET /api/auth/me getAuthMe",
      "GET /api/experience-host/identity getExperienceHostIdentity",
      "GET /api/experience-host/legacy-providers/{legacyProviderId}/connect-account getExperienceHostLegacyConnectAccount",
      "GET /api/experience-providers/{providerId}/bookings listExperienceProviderBookings",
      "GET /api/experience-providers/{providerId}/bookings/{requestId} getExperienceProviderBooking",
      "POST /api/experience-providers/{providerId}/pages/{pageId}/bookings/{requestId}/approve approveExperienceProviderBooking",
      "POST /api/experience-providers/{providerId}/pages/{pageId}/bookings/{requestId}/cancel cancelExperienceProviderBooking",
      "POST /api/experience-providers/{providerId}/pages/{pageId}/bookings/{requestId}/decline declineExperienceProviderBooking",
      "POST /api/experience-providers/{providerId}/pages/{pageId}/bookings/{requestId}/message messageExperienceProviderGuest",
    ].sort());
    expect(operations.join("\n")).not.toMatch(/listExperienceProviders|registerExperienceProvider|PaymentConnect|reuse-candidates|pages\/{pageId} getExperienceProviderPage/);
  });
});
