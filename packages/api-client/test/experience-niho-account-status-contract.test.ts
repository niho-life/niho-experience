import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { EXPERIENCE_NIHO_ACCOUNT_STATUS_API_CONTRACT as contract } from "../src/contract-meta.ts";

describe("NIHO account status contract proposal", () => {
  it("pins the proposed v1 consumer to the NIHO #21003 source contract and its local hash", async () => {
    const file = new URL("../contract/experience-niho-account-status-api.openapi.json", import.meta.url);
    const manifest = JSON.parse(await readFile(new URL("../contract/experience-niho-account-status-api.manifest.json", import.meta.url), "utf8")) as Record<string, unknown>;
    const source = await readFile(file);
    const document = JSON.parse(source.toString("utf8")) as { info: { version: string; [key: string]: unknown } };
    const hash = createHash("sha256").update(source).digest("hex");
    expect(document.info.version).toBe(contract.version);
    expect(document.info["x-niho-contract-status"]).toBe(contract.status);
    expect(contract).toMatchObject({
      sourceIssue: "niho-coliving/niho-app#20988",
      sourcePullRequest: "niho-coliving/niho-app#21003",
      sourceCommit: "e0f6b4ee9174b45398d9921e0e41856676f470ef",
      sourceContractVersion: "2.2.0",
      sourceContractSha256: "e80a1e9db760f73f51ca5076e64232af0bd80250f0f6baf0989521117b1dd7bf",
      status: "proposed",
      deploymentStatus: "not-deployed",
    });
    expect(manifest).toMatchObject({
      version: contract.version,
      sourceIssue: contract.sourceIssue,
      sourcePullRequest: contract.sourcePullRequest,
      sourceCommit: contract.sourceCommit,
      sourceContractVersion: contract.sourceContractVersion,
      sourceContractSha256: contract.sourceContractSha256,
      status: contract.status,
      deploymentStatus: "not-deployed",
      sha256: hash,
    });
    expect(contract.sha256).toBe(hash);
  });
});
