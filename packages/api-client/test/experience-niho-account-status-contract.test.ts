import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { EXPERIENCE_NIHO_ACCOUNT_STATUS_API_CONTRACT as contract } from "../src/contract-meta.ts";

describe("NIHO account status contract proposal", () => {
  it("keeps the proposed version, source issue, and local contract hash explicit", async () => {
    const file = new URL("../contract/experience-niho-account-status-api.openapi.json", import.meta.url);
    const manifest = JSON.parse(await readFile(new URL("../contract/experience-niho-account-status-api.manifest.json", import.meta.url), "utf8")) as Record<string, unknown>;
    const source = await readFile(file);
    const document = JSON.parse(source.toString("utf8")) as { info: { version: string; [key: string]: unknown } };
    const hash = createHash("sha256").update(source).digest("hex");
    expect(document.info.version).toBe(contract.version);
    expect(document.info["x-niho-contract-status"]).toBe(contract.status);
    expect(contract).toMatchObject({ sourceIssue: "niho-coliving/niho-app#20988", sourceCommit: null, status: "proposed", deploymentStatus: "not-deployed" });
    expect(manifest).toMatchObject({
      version: contract.version,
      sourceIssue: contract.sourceIssue,
      sourceCommit: null,
      status: contract.status,
      deploymentStatus: "not-deployed",
      sha256: hash,
    });
    expect(contract.sha256).toBe(hash);
  });
});
