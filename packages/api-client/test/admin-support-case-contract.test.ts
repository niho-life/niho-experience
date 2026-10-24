import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { EXPERIENCE_ADMIN_SUPPORT_CASE_API_CONTRACT } from "../src/contract-meta.ts";
import { generateContractTypes } from "../scripts/gen-types.ts";

type Json = Record<string, any>;

async function load(name: string): Promise<Json> {
  return JSON.parse(await readFile(new URL(`../contract/${name}`, import.meta.url), "utf8")) as Json;
}

describe("選別済み Experience Admin support case 契約", () => {
  it("固定版・source commit・未配備状態・sha256が一致する", async () => {
    const body = await readFile(new URL("../contract/experience-admin-support-case-api.openapi.json", import.meta.url));
    const recorded = await readFile(new URL("../contract/experience-admin-support-case-api.openapi.json.sha256", import.meta.url), "utf8");
    const document = JSON.parse(body.toString("utf8")) as Json;
    const manifest = await load("experience-admin-support-case-api.manifest.json");
    expect(recorded.trim()).toBe(`${createHash("sha256").update(body).digest("hex")}  experience-admin-support-case-api.openapi.json`);
    expect(createHash("sha256").update(body).digest("hex")).toBe("08d4a294aa33ad4ef6110f2bc58e6765a37f3410642d7b42ac5ee653b67e509c");
    expect(document.info.version).toBe(EXPERIENCE_ADMIN_SUPPORT_CASE_API_CONTRACT.version);
    expect(document.info["x-niho-contract-status"]).toBe(EXPERIENCE_ADMIN_SUPPORT_CASE_API_CONTRACT.status);
    expect(manifest).toMatchObject({
      version: EXPERIENCE_ADMIN_SUPPORT_CASE_API_CONTRACT.version,
      sourceCommit: EXPERIENCE_ADMIN_SUPPORT_CASE_API_CONTRACT.sourceCommit,
      deploymentStatus: EXPERIENCE_ADMIN_SUPPORT_CASE_API_CONTRACT.deploymentStatus,
    });
  });

  it("担当・内部メモ・候補一覧の固定2 pathと3操作だけを持つ", async () => {
    const document = await load("experience-admin-support-case-api.openapi.json");
    expect(Object.keys(document.paths).sort()).toEqual([
      "/api/admin/experience-bookings/{requestId}/support-case",
      "/api/admin/experience-support-admins",
    ].sort());
    expect(Object.keys(document.paths["/api/admin/experience-bookings/{requestId}/support-case"]).sort()).toEqual(["get", "patch"]);
    expect(Object.keys(document.paths["/api/admin/experience-support-admins"])).toEqual(["get"]);
    expect(JSON.stringify(document.paths)).not.toMatch(/approve|decline|refund|message.*send/i);
  });

  it("生成型が固定JSONとbyte一致する", async () => {
    const committed = await readFile(new URL("../src/generated/admin-support-case-openapi.ts", import.meta.url), "utf8");
    expect(committed).toBe(await generateContractTypes("admin-support-case"));
  });
});
