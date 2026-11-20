import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import contract from "../contract/niho-login-v1.contract.json";
import manifest from "../contract/niho-login-v1.manifest.json";

describe("NIHO Login consumer contract", () => {
  it("pins the selected version and the provider artifact by digest", async () => {
    const contents = await readFile(new URL(`../contract/${manifest.contractFile}`, import.meta.url));
    const checksum = await readFile(new URL(`../contract/${manifest.sha256File}`, import.meta.url), "utf8");
    expect(manifest.sourceRepository).toBe("niho-coliving/niho-app");
    expect(manifest.sourceBlob).toMatch(/^[a-f0-9]{40}$/);
    expect(contract.version).toBe(manifest.version);
    expect(createHash("sha256").update(contents).digest("hex")).toBe(manifest.sha256);
    expect(checksum.trim()).toBe(manifest.sha256);
  });
});
