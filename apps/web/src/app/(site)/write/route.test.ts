import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/config", () => ({ config: { guideEditorSiteOrigin: "https://editor.example.invalid" } }));

import { GET } from "./route";

describe("GET /write", () => {
  it("redirects once to the fixed Editor new-page context and forwards only a safe experience slug", () => {
    const response = GET(new Request("https://experience.example.invalid/write?experience=morning-walk&nihoUserId=secret&url=https://evil.invalid"));
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("https://editor.example.invalid/p/new?destination=exp&lang=en&experience=morning-walk");
  });

  it("rejects duplicate or unsafe slugs without redirecting", async () => {
    for (const query of ["experience=one&experience=two", "experience=..%2Fprivate", "experience=UPPER"] ) {
      const response = GET(new Request(`https://experience.example.invalid/write?${query}`));
      expect(response.status).toBe(400);
      expect(response.headers.get("location")).toBeNull();
    }
  });
});
