import { describe, expect, it } from "vitest";
import { run } from "../../../../scripts/experience/ops/main.ts";
import { parsePeopleFile, type PersonRow } from "../../../../scripts/experience/ops/people.ts";
import type { Api } from "../../../../scripts/experience/ops/core.ts";

const ID = "plg_00000000000000000000000000000001";
const person: PersonRow = {
  key: ID, providerId: "p1", providerName: "合成提供者", memberId: "member-one", memberRole: "OWNER", name: "合成メンバー",
  legacyName: null, visible: true, listing: { id: ID, slug: "tester", sortOrder: 20, version: 3, updatedAtUtc: "2026-11-01T00:00:00.000Z" },
};
const file = (listing: Record<string, unknown>) => JSON.stringify({ items: [{ providerId: "p1", listing: { slug: "tester", ...listing } }] });

function fixture(initial: PersonRow[] = [person]) {
  let people = initial;
  const sent: { method: string; body: Record<string, unknown> }[] = [];
  const api: Api = {
    env: "stg", aiKind: "claude-code",
    async get() { return { status: 200, body: { people } }; },
    async send(method, _url, value) {
      const body = value as Record<string, unknown>;
      sent.push({ method, body });
      if (method === "DELETE") people = people.filter((row) => row.listing?.id !== body.listingId);
      else {
        const listing = body.listing as { slug: string; sortOrder: number };
        people = [{ ...person, listing: { ...person.listing!, ...listing, version: 4 } }];
      }
      return { status: 200, body: { people } };
    },
  };
  const execute = (args: string[], content = "") => run(["people", ...args], { environment: {}, api, now: () => Date.parse("2026-11-14T00:00:00.000Z"), readFile: () => content });
  return { execute, sent };
}

describe("operator CLI people listings", () => {
  it("only accepts slug and order and rejects edits that belong to the profile or experience", () => {
    expect(parsePeopleFile(file({ sortOrder: 30 }))).toEqual([{ providerId: "p1", listing: { slug: "tester", sortOrder: 30 } }]);
    for (const key of ["experiences", "photo", "nameJa", "introJa"]) expect(() => parsePeopleFile(file({ [key]: [] }))).toThrow(/only slug and sortOrder/);
  });

  it("previews, saves the placement with the version read and skips an unchanged repeat", async () => {
    const { execute, sent } = fixture();
    const args = ["apply", "--file", "people.json"];
    const content = file({ sortOrder: 10 });
    expect((await execute(args, content)).output).toMatchObject({ result: { items: [{ status: "dry_run" }] } });
    expect(sent).toHaveLength(0);
    expect((await execute([...args, "--yes"], content)).output).toMatchObject({ result: { items: [{ status: "applied" }] } });
    expect(sent).toEqual([{ method: "PUT", body: { providerId: "p1", memberId: "member-one", listingId: ID, expectedVersion: 3, listing: { slug: "tester", sortOrder: 10 } } }]);
    expect((await execute([...args, "--yes"], content)).output).toMatchObject({ result: { items: [{ status: "unchanged" }] } });
  });

  it("requires a member when creating a listing and leaves an existing member attached", async () => {
    const args = ["apply", "--file", "people.json", "--yes"];
    const empty = fixture([]);
    expect((await empty.execute(args, file({ sortOrder: 20 }))).exit).toBe(1);
    expect(empty.sent).toHaveLength(0);
    const existing = fixture();
    const otherMember = JSON.stringify({ items: [{ providerId: "p1", memberId: "member-two", listing: { slug: "tester", sortOrder: 20 } }] });
    expect((await existing.execute(args, otherMember)).exit).toBe(1);
    expect(existing.sent).toHaveLength(0);
  });

  it("filters the listing and removes it with the version read", async () => {
    const { execute, sent } = fixture([person, { ...person, key: "new:p2", providerId: "p2", listing: null, visible: false }]);
    expect((await execute(["list", "--listed", "--slug", "tester"])).output).toMatchObject({ result: { count: 1 } });
    expect((await execute(["list", "--provider", "p2", "--unlisted"])).output).toMatchObject({ result: { count: 1 } });
    expect((await execute(["withdraw", "--slug", "tester", "--yes"])).exit).toBe(0);
    expect(sent).toEqual([{ method: "DELETE", body: { listingId: ID, expectedVersion: 3 } }]);
  });
});
