import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { EXPERIENCE_TRANSLATE_ROOMS_API_CONTRACT } from "../src/contract-meta.ts";
import { EXPERIENCE_TRANSLATE_PARTICIPANT_ROLES, EXPERIENCE_TRANSLATE_ROOM_STATES } from "../src/experience-translate-rooms/types.ts";
import { generateContractTypes } from "../scripts/gen-types.ts";

type ContractDocument = {
  info: { version: string; "x-niho-contract-status"?: string };
  paths: Record<string, Record<string, unknown>>;
  components: { schemas: Record<string, { enum?: string[]; properties?: Record<string, unknown> }> };
};

describe("experience translate rooms draft contract", () => {
  it("pins the exact draft of the Epic's shape, its version and the generated types", async () => {
    const name = "experience-translate-rooms-api.openapi.json";
    const body = await readFile(new URL(`../contract/${name}`, import.meta.url));
    const document = JSON.parse(body.toString("utf8")) as ContractDocument;
    const recorded = await readFile(new URL(`../contract/${name}.sha256`, import.meta.url), "utf8");
    const hash = createHash("sha256").update(body).digest("hex");

    expect(recorded.trim()).toBe(`${hash}  ${name}`);
    expect(hash).toBe(EXPERIENCE_TRANSLATE_ROOMS_API_CONTRACT.sha256);
    expect(document.info.version).toBe(EXPERIENCE_TRANSLATE_ROOMS_API_CONTRACT.version);
    expect(document.info["x-niho-contract-status"]).toBe("draft");
    const manifest = JSON.parse(await readFile(new URL("../contract/experience-translate-rooms-api.manifest.json", import.meta.url), "utf8")) as {
      version: string; sourceIssue: string; sourceCommit: string | null; sha256: string; status: string;
    };
    expect(manifest).toMatchObject({ version: EXPERIENCE_TRANSLATE_ROOMS_API_CONTRACT.version, sourceIssue: EXPERIENCE_TRANSLATE_ROOMS_API_CONTRACT.sourceIssue, sourceCommit: null, sha256: hash, status: "draft" });
    expect(EXPERIENCE_TRANSLATE_ROOMS_API_CONTRACT.status).toBe("draft");
    expect(EXPERIENCE_TRANSLATE_ROOMS_API_CONTRACT.deploymentStatus).toBe("not-deployed");
    expect(await readFile(new URL("../src/generated/experience-translate-rooms-openapi.ts", import.meta.url), "utf8")).toBe(
      await generateContractTypes("experience-translate-rooms"),
    );
  });

  it("covers only the three host-side room operations of the Epic, with closed schemas and no relay or budget fields", async () => {
    const document = JSON.parse(await readFile(new URL("../contract/experience-translate-rooms-api.openapi.json", import.meta.url), "utf8")) as ContractDocument;
    const root = "/api/experience-providers/{providerId}/bookings/{requestId}/translate-rooms";
    expect(Object.keys(document.paths).sort()).toEqual([root, `${root}/{roomId}`, `${root}/{roomId}/end`]);
    expect(Object.keys(document.paths[root] ?? {})).toEqual(["parameters", "post"]);
    expect(Object.keys(document.paths[`${root}/{roomId}`] ?? {})).toEqual(["parameters", "get"]);
    expect(Object.keys(document.paths[`${root}/{roomId}/end`] ?? {})).toEqual(["parameters", "post"]);
    expect(document.components.schemas.TranslateRoomState?.enum).toEqual([...EXPERIENCE_TRANSLATE_ROOM_STATES]);
    expect(document.components.schemas.TranslateParticipantRole?.enum).toEqual([...EXPERIENCE_TRANSLATE_PARTICIPANT_ROLES]);
    const text = JSON.stringify(document.components.schemas);
    for (const word of ["ticket", "relayUrl", "budget", "price", "email", "jwks"]) expect(text.toLowerCase()).not.toContain(word);
    for (const schema of Object.values(document.components.schemas)) {
      if (schema.properties) expect((schema as { additionalProperties?: boolean }).additionalProperties).toBe(false);
    }
  });
});
