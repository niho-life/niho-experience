import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ editorMutationAllowed: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/editor/server", () => ({ editorMutationAllowed: mocks.editorMutationAllowed }));

import { POST as createLegacyGuide } from "@/app/(editor)/editor/api/guides/route";
import { GET as listLegacyWriterLinks } from "@/app/(editor)/editor/api/guide-link-invitations/route";
import { POST as respondLegacyWriterLink } from "@/app/(editor)/editor/api/guide-link-invitations/[invitationId]/[action]/route";
import { POST as revokeLegacyHostLink } from "@/app/(host)/host/api/guide-link-invitations/[invitationId]/revoke/route";

const SITE = "https://experience.example.invalid";
const ID = "00000000-0000-4000-8000-000000000042";

describe("retired Experience writer and Store link mutations", () => {
  it("returns 410 before reading a legacy write body or consulting mutation auth", async () => {
    const request = new Request(`${SITE}/editor/api/guides`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "private body" }),
    });
    const response = await createLegacyGuide(request);
    expect(response.status).toBe(410);
    expect(await response.json()).toEqual({ error: "gone" });
    expect(mocks.editorMutationAllowed).not.toHaveBeenCalled();
  });

  it("returns the same 410 for old writer invitation reads/responses and the old host revoke path", async () => {
    const list = await listLegacyWriterLinks(new Request(`${SITE}/editor/api/guide-link-invitations`));
    const respond = await respondLegacyWriterLink(new Request(`${SITE}/editor/api/guide-link-invitations/${ID}/accept`, { method: "POST" }), {
      params: Promise.resolve({ invitationId: ID, action: "accept" }),
    });
    const revoke = revokeLegacyHostLink();
    for (const response of [list, respond, revoke]) {
      expect(response.status).toBe(410);
      expect(await response.json()).toEqual({ error: "gone" });
    }
  });
});
