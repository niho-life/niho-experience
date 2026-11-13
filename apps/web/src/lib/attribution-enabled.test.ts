import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ config: { publicApiVersion: "1.0", apiMode: "http", experiencePublicationsEnabled: true } as Record<string, unknown> }));
vi.mock("@/lib/config", () => ({ config: mocks.config }));
vi.mock("./config", () => ({ config: mocks.config }));

import { attributionEnabled } from "./attribution-enabled";

describe("流入の印の取り込み（#531・#59）", () => {
  beforeEach(() => { Object.assign(mocks.config, { publicApiVersion: "1.0", apiMode: "http", experiencePublicationsEnabled: true }); });

  it("このサイトが公開する体験（http mode・公開機能 ON）では API の版によらず取り込む。NIHO のカタログは 1.2 のとき", () => {
    expect(attributionEnabled()).toBe(true);
    mocks.config.experiencePublicationsEnabled = false;
    expect(attributionEnabled()).toBe(false);
    mocks.config.publicApiVersion = "1.2";
    expect(attributionEnabled()).toBe(true);
    Object.assign(mocks.config, { publicApiVersion: "1.0", apiMode: "mock", experiencePublicationsEnabled: true });
    expect(attributionEnabled()).toBe(false);
  });

  it("英語と日本語のレイアウトの両方が同じ取り込みを置く", () => {
    for (const path of ["src/app/(site)/layout.tsx", "src/app/(ja)/ja/layout.tsx"]) {
      const source = readFileSync(path, "utf8");
      expect(source).toContain("<AttributionCapture enabled={attributionEnabled()} />");
    }
  });
});
