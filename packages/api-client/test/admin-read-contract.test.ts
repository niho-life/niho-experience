import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { EXPERIENCE_ADMIN_READ_API_CONTRACT } from "../src/contract-meta.ts";

type Json = Record<string, any>;

async function load(name: string): Promise<Json> {
  return JSON.parse(await readFile(new URL(`../contract/${name}`, import.meta.url), "utf8")) as Json;
}

describe("選別済み Experience Admin read 契約", () => {
  it("固定版・source commit・未配備状態・sha256が一致する", async () => {
    const body = await readFile(new URL("../contract/experience-admin-read-api.openapi.json", import.meta.url));
    const recorded = await readFile(new URL("../contract/experience-admin-read-api.openapi.json.sha256", import.meta.url), "utf8");
    const document = JSON.parse(body.toString("utf8")) as Json;
    const manifest = await load("experience-admin-read-api.manifest.json");
    expect(recorded.trim()).toBe(`${createHash("sha256").update(body).digest("hex")}  experience-admin-read-api.openapi.json`);
    expect(document.info.version).toBe(EXPERIENCE_ADMIN_READ_API_CONTRACT.version);
    expect(document.info["x-niho-contract-status"]).toBe(EXPERIENCE_ADMIN_READ_API_CONTRACT.status);
    expect(manifest).toMatchObject({
      version: EXPERIENCE_ADMIN_READ_API_CONTRACT.version,
      sourceCommit: EXPERIENCE_ADMIN_READ_API_CONTRACT.sourceCommit,
      deploymentStatus: EXPERIENCE_ADMIN_READ_API_CONTRACT.deploymentStatus,
    });
  });

  it("Admin readの固定5 pathだけを持ち、更新系予約操作を含まない", async () => {
    const document = await load("experience-admin-read-api.openapi.json");
    expect(Object.keys(document.paths).sort()).toEqual([
      "/api/admin/experience-bookings",
      "/api/admin/experience-bookings/query",
      "/api/admin/experience-bookings/{requestId}",
      "/api/admin/experience-support-notifications",
      "/api/admin/experience-support-notifications/read",
    ].sort());
    expect(document.paths["/api/admin/experience-bookings/query"].post).toBeDefined();
    expect(JSON.stringify(document.paths)).not.toMatch(/approve|decline|refund.*post|message.*post/i);
  });
});
