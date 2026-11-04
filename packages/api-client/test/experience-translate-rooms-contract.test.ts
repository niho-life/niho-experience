import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { EXPERIENCE_TRANSLATE_ROOMS_API_CONTRACT } from "../src/contract-meta.ts";
import { EXPERIENCE_TRANSLATE_PARTICIPANT_ROLES, EXPERIENCE_TRANSLATE_ROOM_STATES } from "../src/experience-translate-rooms/types.ts";
import { isExperienceTranslateRoomsSchema } from "../src/experience-translate-rooms/schema.ts";
import { generateContractTypes } from "../scripts/gen-types.ts";

type ContractDocument = {
  info: { version: string; "x-niho-contract-status"?: string };
  paths: Record<string, Record<string, unknown>>;
  components: { schemas: Record<string, { enum?: string[]; properties?: Record<string, unknown>; "x-niho-experience-translate-rooms-dto"?: boolean }> };
};

describe("experience translate rooms selected contract", () => {
  it("予約なしcurrentの空状態を受け入れ、資格情報の混入を拒否する", () => {
    expect(isExperienceTranslateRoomsSchema("StandaloneTranslateRoomCurrent", { room: null })).toBe(true);
    expect(isExperienceTranslateRoomsSchema("StandaloneTranslateRoomCurrent", { room: null, ticket: "synthetic" })).toBe(false);
    expect(isExperienceTranslateRoomsSchema("StandaloneTranslateRoomCreateRequest", { hostLanguage: "ja", ownerId: "synthetic" })).toBe(false);
    expect(isExperienceTranslateRoomsSchema("StandaloneTranslateRoomCreateRequest", { hostLanguage: "fr" })).toBe(false);
  });

  it("pins NIHO's selected export, its version and the generated types", async () => {
    const name = "experience-translate-rooms-api.openapi.json";
    const body = await readFile(new URL(`../contract/${name}`, import.meta.url));
    const document = JSON.parse(body.toString("utf8")) as ContractDocument;
    const recorded = await readFile(new URL(`../contract/${name}.sha256`, import.meta.url), "utf8");
    const hash = createHash("sha256").update(body).digest("hex");

    expect(recorded.trim()).toBe(`${hash}  ${name}`);
    expect(hash).toBe(EXPERIENCE_TRANSLATE_ROOMS_API_CONTRACT.sha256);
    expect(document.info.version).toBe(EXPERIENCE_TRANSLATE_ROOMS_API_CONTRACT.version);
    expect(document.info["x-niho-contract-status"]).toBe("agreed-not-deployed");
    const manifest = JSON.parse(await readFile(new URL("../contract/experience-translate-rooms-api.manifest.json", import.meta.url), "utf8")) as {
      version: string; sourceIssue: string; sourceCommit: string | null; sha256: string; status: string; deploymentStatus: string;
    };
    expect(manifest.sourceCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(manifest).toMatchObject({ version: EXPERIENCE_TRANSLATE_ROOMS_API_CONTRACT.version, sourceIssue: EXPERIENCE_TRANSLATE_ROOMS_API_CONTRACT.sourceIssue, sourceCommit: EXPERIENCE_TRANSLATE_ROOMS_API_CONTRACT.sourceCommit, sha256: hash, status: "agreed-not-deployed", deploymentStatus: EXPERIENCE_TRANSLATE_ROOMS_API_CONTRACT.deploymentStatus });
    expect(EXPERIENCE_TRANSLATE_ROOMS_API_CONTRACT.status).toBe("agreed-not-deployed");
    expect(EXPERIENCE_TRANSLATE_ROOMS_API_CONTRACT.deploymentStatus).toBe("not-deployed");
    expect(await readFile(new URL("../src/generated/experience-translate-rooms-openapi.ts", import.meta.url), "utf8")).toBe(
      await generateContractTypes("experience-translate-rooms"),
    );
  });

  it("covers the legacy and site-booking room operations, with closed schemas and no relay or budget fields", async () => {
    const document = JSON.parse(await readFile(new URL("../contract/experience-translate-rooms-api.openapi.json", import.meta.url), "utf8")) as ContractDocument;
    const legacy = "/api/experience-providers/{providerId}/bookings/{requestId}/translate-rooms";
    const site = "/api/experience-providers/{providerId}/site-bookings/{bookingId}/translate-rooms";
    expect(Object.keys(document.paths).sort()).toEqual([
      legacy, `${legacy}/{roomId}`, `${legacy}/{roomId}/end`, site, `${site}/{roomId}`, `${site}/{roomId}/end`,
      "/api/experience-providers/{providerId}/translate-rooms",
      "/api/experience-providers/{providerId}/translate-rooms/current",
      "/api/experience-providers/{providerId}/translate-rooms/{roomId}",
      "/api/experience-providers/{providerId}/translate-rooms/{roomId}/invites/host",
      "/api/experience-providers/{providerId}/translate-rooms/{roomId}/invites/guest",
      "/api/experience-providers/{providerId}/translate-rooms/{roomId}/end",
    ].sort());
    for (const root of [legacy, site]) {
      expect(Object.keys(document.paths[root] ?? {})).toEqual(["parameters", "post"]);
      expect(Object.keys(document.paths[`${root}/{roomId}`] ?? {})).toEqual(["parameters", "get"]);
      expect(Object.keys(document.paths[`${root}/{roomId}/end`] ?? {})).toEqual(["parameters", "post"]);
    }
    const created = document.components.schemas.ExperienceProviderTranslateRoomCreated?.properties as Record<string, { enum?: string[] }>;
    const participant = document.components.schemas.ExperienceProviderTranslateRoomParticipant?.properties as Record<string, { enum?: string[] }>;
    expect(created.state?.enum).toEqual([...EXPERIENCE_TRANSLATE_ROOM_STATES]);
    expect(participant.role?.enum).toEqual([...EXPERIENCE_TRANSLATE_PARTICIPANT_ROLES]);
    const text = JSON.stringify(document.components.schemas);
    for (const word of ["ticket", "relayUrl", "budget", "price", "email", "jwks"]) expect(text.toLowerCase()).not.toContain(word);
    for (const schema of Object.values(document.components.schemas)) {
      if (schema["x-niho-experience-translate-rooms-dto"] && schema.properties) expect((schema as { additionalProperties?: boolean }).additionalProperties).toBe(false);
    }
  });
});
