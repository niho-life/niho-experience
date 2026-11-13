import { describe, expect, it } from "vitest";
import { run } from "../../../../scripts/experience/ops/main.ts";
import type { Api, ApiResponse } from "../../../../scripts/experience/ops/core.ts";

/* 運営の CLI (#576) ⑥: the inquiry and assignment targets against in-memory copies of the Admin APIs. Synthetic data only. */

const NOW = Date.parse("2026-11-14T00:00:00.000Z");
const ID1 = "11111111-1111-4111-8111-111111111111";
const record = (over: Record<string, unknown> = {}) => ({
  id: ID1, inquiryRef: "REF-1", kind: "GROUP", locale: "ja", entry: "FORM", experienceSlug: null, replyByOn: "2026-11-20", status: "NEW", assigneeLabel: null, nextDueOn: null, staffNote: null,
  createdAt: "2026-11-13T00:00:00.000Z", updatedAt: "2026-11-13T00:00:00.000Z",
  contactName: "Sample Person", contactEmail: "sender@example.test", message: "private words", details: { people: 4 }, ...over,
});

function inquiryApi() {
  let row: Record<string, unknown> = record();
  const sent: Array<{ body: Record<string, unknown>; operationId: string }> = [];
  const seen = new Set<string>();
  const api: Api = {
    env: "stg", aiKind: "codex",
    async get(path) { return path.startsWith("/admin/api/inquiries") ? { status: 200, body: { inquiries: [row], counts: { NEW: 1 }, today: "2026-11-14" } } : { status: 404, body: {} }; },
    async send(_method, _path, body, operationId): Promise<ApiResponse> {
      sent.push({ body: body as Record<string, unknown>, operationId });
      if (seen.has(operationId)) return { status: 409, body: { error: "operation_already_recorded" } };
      seen.add(operationId);
      const { action: _action, id: _id, ...patch } = body as Record<string, unknown>;
      row = { ...row, ...patch };
      return { status: 200, body: { inquiry: row } };
    },
  };
  return { api, sent };
}
const exec = (target: string, api: Api, argv: string[]) => run([target, ...argv], { environment: {}, api, now: () => NOW });
// Fake-API JSON has no fixed shape in these tests, so `any` is allowed for this one alias.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = Record<string, any>;
const out = (o: Awaited<ReturnType<typeof run>>) => o.output as Loose;

describe("inquiry", () => {
  it("lists without the sender's name, address or message, and the details", async () => {
    const fake = inquiryApi();
    const result = out(await exec("inquiry", fake.api, ["list"])).result;
    expect(result.count).toBe(1);
    const text = JSON.stringify(result);
    for (const secret of ["Sample Person", "sender@example.test", "private words"]) expect(text).not.toContain(secret);
    expect(result.inquiries[0]).toMatchObject({ id: ID1, status: "NEW", kind: "GROUP" });
    expect((await exec("inquiry", fake.api, ["list", "--status", "OPEN"])).exit).toBe(2);
  });
  it("changes only the fields given, plans first, and a repeat changes nothing", async () => {
    const fake = inquiryApi();
    const flags = ["update", "--id", ID1, "--status", "IN_PROGRESS", "--assignee", "高濱", "--due", "2026-11-18"];
    const planned = out(await exec("inquiry", fake.api, flags));
    expect(planned).toMatchObject({ tier: "edit", mode: "dry-run", result: { status: "dry_run" } });
    expect(planned.result.changes.map((change: { path: string }) => change.path).sort()).toEqual(["assigneeLabel", "nextDueOn", "status"]);
    expect(fake.sent).toEqual([]);
    expect(out(await exec("inquiry", fake.api, [...flags, "--yes"])).result.status).toBe("applied");
    expect(fake.sent[0]!.body).toEqual({ action: "update", id: ID1, status: "IN_PROGRESS", assigneeLabel: "高濱", nextDueOn: "2026-11-18" });
    expect(out(await exec("inquiry", fake.api, [...flags, "--yes"])).result.status).toBe("unchanged");
    expect(out(await exec("inquiry", fake.api, ["update", "--id", ID1, "--assignee", "", "--yes"])).result.status).toBe("applied");
    expect(fake.sent[1]!.body).toEqual({ action: "update", id: ID1, assigneeLabel: null });
  });
  it("refuses a bad id, status or date and an update that gives nothing", async () => {
    const fake = inquiryApi();
    for (const argv of [["update", "--status", "DONE"], ["update", "--id", "nope", "--status", "DONE"], ["update", "--id", ID1, "--status", "X"], ["update", "--id", ID1, "--due", "soon"], ["update", "--id", ID1]]) expect((await exec("inquiry", fake.api, [...argv, "--yes"])).exit, argv.join(" ")).toBe(2);
    expect(fake.sent).toEqual([]);
  });
});

describe("assignment", () => {
  const sent: Array<Record<string, unknown>> = [];
  const api: Api = {
    env: "stg", aiKind: "codex",
    async get(path) { return { status: 200, body: path.includes("?") ? { candidates: [{ nihoUserId: "u1", label: "A", kind: "MEMBER" }], history: [] } : { rows: [] } }; },
    async send(_m, _p, body): Promise<ApiResponse> { sent.push(body as Record<string, unknown>); return (body as { subjectNihoUserId?: string }).subjectNihoUserId === "taken" ? { status: 409, body: { error: "already_assigned", outcome: "TAKEN" } } : { status: 200, body: { outcome: "RECORDED" } }; },
  };
  const flags = ["--provider", "prv_1", "--occurrence", "occ_1"];
  it("lists, shows an occurrence's candidates and history, and records a claim only with --yes", async () => {
    expect(out(await exec("assignment", api, ["list"])).result).toEqual({ rows: [] });
    expect(out(await exec("assignment", api, ["list", ...flags])).result.candidates).toHaveLength(1);
    expect((await exec("assignment", api, ["list", "--provider", "prv_1"])).exit).toBe(2);
    expect(out(await exec("assignment", api, ["claim", ...flags, "--subject", "u1"])).result.status).toBe("dry_run");
    expect(sent).toEqual([]);
    const done = out(await exec("assignment", api, ["claim", ...flags, "--subject", "u1", "--reason", "代行", "--yes"]));
    expect(done.result.status).toBe("applied");
    expect(sent[0]).toMatchObject({ action: "CLAIM", providerId: "prv_1", occurrenceId: "occ_1", subjectNihoUserId: "u1", reason: "代行" });
    expect(sent[0]!.commandId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
  it("reports a claim that lost the race, releases without a subject, and has no way to set a fee", async () => {
    expect(out(await exec("assignment", api, ["claim", ...flags, "--subject", "taken", "--yes"])).result).toMatchObject({ status: "failed", error: "already_assigned" });
    expect(out(await exec("assignment", api, ["release", ...flags, "--yes"])).result.status).toBe("applied");
    expect(sent.at(-1)).toMatchObject({ action: "RELEASE" });
    expect((await exec("assignment", api, ["claim", ...flags, "--yes"])).exit).toBe(2);
    expect((await exec("assignment", api, ["set-fee", ...flags, "--yes"])).exit).toBe(2);
  });
});
