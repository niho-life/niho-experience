import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { EXPERIENCE_HOST_API_CONTRACT, EXPERIENCE_PROVIDER_OPERATIONS_API_CONTRACT } from "../src/contract-meta.ts";
import { EXPERIENCE_PROVIDER_OPERATION_ROLES } from "../src/experience-provider-operations/types.ts";
import { generateContractTypes } from "../scripts/gen-types.ts";

type ContractDocument = {
  info: { version: string; "x-niho-contract-status"?: string };
  components: { schemas: Record<string, { enum?: string[] }> };
};

async function readContract(name: string): Promise<{ body: Buffer; document: ContractDocument }> {
  const body = await readFile(new URL(`../contract/${name}`, import.meta.url));
  return { body, document: JSON.parse(body.toString("utf8")) as ContractDocument };
}

describe("experience provider operations selected contract", () => {
  it("pins the exact copied contract, version and generated types", async () => {
    const name = "experience-provider-operations-api.openapi.json";
    const { body, document } = await readContract(name);
    const recorded = await readFile(new URL(`../contract/${name}.sha256`, import.meta.url), "utf8");
    const hash = createHash("sha256").update(body).digest("hex");

    expect(recorded.trim()).toBe(`${hash}  ${name}`);
    expect(hash).toBe(EXPERIENCE_PROVIDER_OPERATIONS_API_CONTRACT.sha256);
    expect(document.info.version).toBe(EXPERIENCE_PROVIDER_OPERATIONS_API_CONTRACT.version);
    expect(EXPERIENCE_PROVIDER_OPERATIONS_API_CONTRACT.status).toBe("agreed-not-deployed");
    expect(await readFile(new URL("../src/generated/experience-provider-operations-openapi.ts", import.meta.url), "utf8")).toBe(
      await generateContractTypes("experience-provider-operations"),
    );
  });

  it("keeps the draft host role enum anchored to the independent canonical operations role", async () => {
    const operations = (await readContract("experience-provider-operations-api.openapi.json")).document;
    const host = (await readContract("experience-host-api.openapi.json")).document;
    expect(operations.components.schemas.ProviderRole?.enum).toEqual(["OWNER", "EDITOR", "COHOST"]);
    expect(host.components.schemas.ExperienceProviderMemberRole?.enum).toEqual(operations.components.schemas.ProviderRole?.enum);
    expect(EXPERIENCE_PROVIDER_OPERATION_ROLES).toEqual(operations.components.schemas.ProviderRole?.enum);
    expect(EXPERIENCE_HOST_API_CONTRACT.status).toBe("draft");
  });
});
