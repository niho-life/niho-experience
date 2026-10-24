import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { EXPERIENCE_ADMIN_AUTH_API_CONTRACT } from "../src/contract-meta.ts";

type Json = Record<string, any>;

async function load(name: string): Promise<Json> {
  return JSON.parse(await readFile(new URL(`../contract/${name}`, import.meta.url), "utf8")) as Json;
}

describe("選別済み Experience Admin 認証契約", () => {
  it("固定した版・source SHA・未配備状態とファイルの sha256 が一致する", async () => {
    const body = await readFile(new URL("../contract/experience-admin-auth-api.openapi.json", import.meta.url));
    const recorded = await readFile(new URL("../contract/experience-admin-auth-api.openapi.json.sha256", import.meta.url), "utf8");
    const document = JSON.parse(body.toString("utf8")) as Json;
    const manifest = await load("experience-admin-auth-api.manifest.json");
    expect(recorded.trim()).toBe(`${createHash("sha256").update(body).digest("hex")}  experience-admin-auth-api.openapi.json`);
    expect(document.info.version).toBe(EXPERIENCE_ADMIN_AUTH_API_CONTRACT.version);
    expect(document.info["x-niho-contract-status"]).toBe(EXPERIENCE_ADMIN_AUTH_API_CONTRACT.status);
    expect(manifest).toMatchObject({
      version: EXPERIENCE_ADMIN_AUTH_API_CONTRACT.version,
      sourceCommit: EXPERIENCE_ADMIN_AUTH_API_CONTRACT.sourceCommit,
      deploymentStatus: EXPERIENCE_ADMIN_AUTH_API_CONTRACT.deploymentStatus,
    });
  });

  it("Admin client、Firebase bearer、認証5操作だけに範囲を閉じる", async () => {
    const document = await load("experience-admin-auth-api.openapi.json");
    expect(document.components.schemas.AuthAppConnectClientId.enum).toEqual(["niho-experience-admin"]);
    expect(document.components.securitySchemes).toEqual({
      FirebaseIdToken: expect.objectContaining({ type: "http", scheme: "bearer" }),
    });
    expect(Object.keys(document.paths).sort()).toEqual([
      "/api/auth/app-connect/exchange",
      "/api/auth/app-connect/experience-admin/session",
      "/api/auth/app-connect/refresh",
      "/api/auth/app-connect/start",
      "/api/auth/app-connections/{connectionId}",
    ].sort());
    expect(document.components.schemas.AuthAppConnectStartRequest.required).toContain("redirectOrigin");
    expect(document.components.schemas.AuthAppConnectStartResponse.properties.redirectUrl.description).toContain("/admin/auth/callback");
    expect(JSON.stringify(document.paths)).not.toMatch(/booking|pricing|notification|host.setting/i);
  });
});
