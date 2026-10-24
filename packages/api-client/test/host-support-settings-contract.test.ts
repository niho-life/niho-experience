import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { EXPERIENCE_HOST_SUPPORT_SETTINGS_API_CONTRACT } from "../src/contract-meta.ts";
import { generateContractTypes } from "../scripts/gen-types.ts";

const NAME = "experience-host-support-settings-api";
const SHA = "9cff926462fe388b8ff5a8c82a582eb26d6aafc8eba49f5468ea064021c07a75";

describe("selected Host support settings contract", () => {
  it("pins the independent v1.0.1 agreed-not-deployed export and source commit", async () => {
    const body = await readFile(new URL(`../contract/${NAME}.openapi.json`, import.meta.url));
    const document = JSON.parse(body.toString("utf8"));
    const recorded = await readFile(new URL(`../contract/${NAME}.openapi.json.sha256`, import.meta.url), "utf8");
    const manifest = JSON.parse(await readFile(new URL(`../contract/${NAME}.manifest.json`, import.meta.url), "utf8"));
    expect(createHash("sha256").update(body).digest("hex")).toBe(SHA);
    expect(recorded.trim()).toBe(`${SHA}  ${NAME}.openapi.json`);
    expect(document.info).toMatchObject({ version: "1.0.1", "x-niho-contract-status": "agreed-not-deployed" });
    expect(manifest).toMatchObject({ version: "1.0.1", sourceCommit: EXPERIENCE_HOST_SUPPORT_SETTINGS_API_CONTRACT.sourceCommit, jsonSha256: SHA, deploymentStatus: "not-deployed" });
  });

  it("contains only the fixed OWNER target list and per-target GET/PUT paths", async () => {
    const document = JSON.parse(await readFile(new URL(`../contract/${NAME}.openapi.json`, import.meta.url), "utf8"));
    expect(Object.keys(document.paths).sort()).toEqual([
      "/api/experience-providers/management/niho-support-hosts",
      "/api/experience-providers/management/niho-support/{hostKind}/{hostId}",
    ]);
    expect(Object.keys(document.paths["/api/experience-providers/management/niho-support-hosts"])).toEqual(["get"]);
    expect(Object.keys(document.paths["/api/experience-providers/management/niho-support/{hostKind}/{hostId}"]).sort()).toEqual(["get", "parameters", "put"]);
    expect(JSON.stringify(document)).not.toMatch(/consentedByUserId|internalMemo|stripeId|database/i);
  });

  it("keeps generated types byte-aligned", async () => {
    expect(await readFile(new URL("../src/generated/host-support-settings-openapi.ts", import.meta.url), "utf8")).toBe(await generateContractTypes("host-support-settings"));
  });
});
