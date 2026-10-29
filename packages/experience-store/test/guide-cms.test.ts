import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import type { Pool } from "pg";
import { StoreValidationError } from "../src/errors.ts";
import { GuideRepository, parseGuideContent } from "../src/guides.ts";

describe("guide CMS schema", () => {
  it("stores article-link invitation consent without private identity fields", async () => {
    const sql = await readFile(new URL("../migrations/0007_guide_link_invitations.sql", import.meta.url), "utf8");
    assert.match(sql, /^BEGIN;/);
    assert.match(sql, /COMMIT;\s*$/);
    assert.match(sql, /CREATE TABLE guide_product_link_invitations/);
    assert.match(sql, /UNIQUE \(provider_id, writer_niho_user_id\)/);
    assert.match(sql, /generation integer NOT NULL DEFAULT 1 CHECK \(generation > 0\)/);
    assert.match(sql, /'PENDING', 'ACCEPTED', 'DECLINED', 'REVOKED'/);
    const invitation = sql.match(/CREATE TABLE guide_product_link_invitations \(([\s\S]*?)\n\);/)?.[1] ?? "";
    assert.doesNotMatch(invitation, /email|display_name|profile|provider_memberships\s*\(/i);
  });

  it("keeps grants separate and seals immutable publication snapshots with their links", async () => {
    const sql = await readFile(new URL("../migrations/0005_guide_cms.sql", import.meta.url), "utf8");
    assert.match(sql, /^BEGIN;/);
    assert.match(sql, /COMMIT;\s*$/);
    assert.match(sql, /CREATE TABLE guide_writer_grants/);
    assert.match(sql, /CREATE TABLE guide_product_link_memberships/);
    assert.doesNotMatch(sql, /invite_email|invitation_token|pending_invite/i);
    assert.match(sql, /guide publication snapshots are immutable/);
    assert.match(sql, /guide publication links are immutable/);
    assert.match(sql, /a published guide slug is immutable/);
    assert.match(sql, /UNIQUE[\s\S]*\(slug\)/);
    assert.match(sql, /permission_basis IN \('PROVIDER_MEMBERSHIP', 'GUIDE_PRODUCT_LINK_MEMBERSHIP'\)/);
    assert.match(sql, /FOREIGN KEY \(provider_id, product_id\)[\s\S]*experience_products/);
  });

  it("stores category labels in the immutable publication rather than depending on current labels", async () => {
    const sql = await readFile(new URL("../migrations/0005_guide_cms.sql", import.meta.url), "utf8");
    const publication = sql.match(/CREATE TABLE guide_publications \(([\s\S]*?)\n\);/)?.[1] ?? "";
    assert.match(publication, /category_slug/);
    assert.match(publication, /category_label_en/);
    assert.match(publication, /category_label_ja/);
    assert.match(publication, /category_display_order/);
  });
});

describe("guide content boundary", () => {
  it("accepts Markdown and public author metadata without producing HTML", () => {
    assert.deepEqual(
      parseGuideContent({
        markdown: "## A synthetic walk\n\nPlain text.",
        author: { name: "Synthetic Writer", role: "Guide", bio: "Writes synthetic test guides." },
        checkedOn: "2026-10-29",
      }),
      {
        markdown: "## A synthetic walk\n\nPlain text.",
        author: { name: "Synthetic Writer", role: "Guide", bio: "Writes synthetic test guides." },
        checkedOn: "2026-10-29",
      },
    );
  });

  it("rejects arbitrary HTML fields and malformed author/date values", () => {
    assert.throws(() => parseGuideContent({ markdown: "safe", html: "<script>bad()</script>" }), StoreValidationError);
    assert.throws(() => parseGuideContent({ markdown: "safe", checkedOn: "29/10/2026" }), StoreValidationError);
    assert.throws(() => parseGuideContent({ markdown: "safe", checkedOn: "2026-02-30" }), StoreValidationError);
    assert.throws(() => parseGuideContent({ markdown: "safe", author: { name: "A", role: "B" } }), StoreValidationError);
  });
});

describe("guide link invitation boundary", () => {
  it("validates stable identifiers, UUID v4 IDs, and positive generations before querying", async () => {
    const repository = new GuideRepository({} as Pool);
    const actor = { nihoUserId: "writer-synthetic" } as const;
    await assert.rejects(
      () => repository.inviteProductLinkWriter(actor, "invalid provider id", "writer-synthetic"),
      StoreValidationError,
    );
    await assert.rejects(
      () => repository.acceptLinkInvitation(actor, "not-a-uuid", 1),
      StoreValidationError,
    );
    await assert.rejects(
      () => repository.declineLinkInvitation(actor, "00000000-0000-4000-8000-000000000001", 0),
      StoreValidationError,
    );
  });
});

describe("guide writing subjects", () => {
  it("returns only the writer grant and OWNER/EDITOR provider IDs", async () => {
    const queries: Array<{ text: string; values: readonly unknown[] }> = [];
    const pool = {
      async query(text: string, values: readonly unknown[]) {
        queries.push({ text, values });
        return {
          rows: [
            { subject_kind: "WRITER", provider_id: null },
            { subject_kind: "PROVIDER", provider_id: "provider-editor" },
          ],
        };
      },
    } as unknown as Pool;
    const repository = new GuideRepository(pool);

    assert.deepEqual(await repository.listWritableSubjects("writer-synthetic"), [
      { kind: "WRITER" },
      { kind: "PROVIDER", providerId: "provider-editor" },
    ]);
    assert.deepEqual(queries[0]?.values, ["writer-synthetic"]);
    assert.match(queries[0]?.text ?? "", /role IN \('OWNER','EDITOR'\)/);
    assert.doesNotMatch(queries[0]?.text ?? "", /email|customer/i);
  });
});
