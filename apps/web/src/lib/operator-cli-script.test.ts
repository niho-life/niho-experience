import { describe, expect, it, vi } from "vitest";
import { EXIT, OpsError, createApi, diffValues, gcloudTokenSource, operationId, parseArgs, resolveAiKind, resolveEnv, tokenExpiry, writeOne, type Api, type Context } from "../../../../scripts/experience/ops/core.ts";
import { run, type Runtime } from "../../../../scripts/experience/ops/main.ts";

/* 運営の CLI (#576): the shared parts of scripts/experience/ops. No network and no gcloud; synthetic values only. */

const NOW = Date.parse("2026-11-14T00:00:00.000Z");
const jwt = (exp: number) => `${Buffer.from("{}").toString("base64url").padEnd(12, "x")}.${Buffer.from(JSON.stringify({ exp })).toString("base64url").padEnd(12, "x")}.${"s".repeat(12)}`;
const GOOD = jwt(Math.floor(NOW / 1000) + 3600);

describe("parseArgs", () => {
  it("takes flags with a value, boolean flags and positionals", () => {
    expect(parseArgs(["classification", "apply", "--file", "a.json", "--env=prd", "--yes"])).toEqual({ positional: ["classification", "apply"], flags: { file: "a.json", env: "prd", yes: true } });
  });
  it("refuses an unknown flag, a missing value and a value on a boolean flag", () => {
    for (const argv of [["--nope"], ["--file"], ["--file", "--yes"], ["--yes=1"]]) expect(() => parseArgs(argv), argv.join(" ")).toThrow(OpsError);
  });
});

describe("environment, AI kind and token", () => {
  it("defaults to stg, names prd only on request, and sends the token nowhere but the two sites (or this machine)", () => {
    expect(resolveEnv({}, {})).toEqual({ name: "stg", origin: "https://experience-stg.niho.life" });
    expect(resolveEnv({ env: "prd" }, {})).toEqual({ name: "prd", origin: "https://experience.niho.life" });
    expect(() => resolveEnv({ env: "production" }, {})).toThrow(/stg or prd/);
    expect(resolveEnv({}, { NIHO_OPS_BASE_URL: "http://127.0.0.1:3000" }).origin).toBe("http://127.0.0.1:3000");
    for (const bad of ["https://evil.example", "http://localhost.evil.example", "http://127.0.0.1.evil.example", "https://127.0.0.1"]) expect(() => resolveEnv({}, { NIHO_OPS_BASE_URL: bad }), bad).toThrow(/NIHO_OPS_BASE_URL/);
  });
  it("tells which AI works from --ai, NIHO_OPS_AI or the AI tool's own environment", () => {
    expect(resolveAiKind({ ai: "codex" }, { CLAUDECODE: "1" })).toBe("codex");
    expect(resolveAiKind({}, { NIHO_OPS_AI: "other" })).toBe("other");
    expect(resolveAiKind({}, { CLAUDECODE: "1" })).toBe("claude-code");
    expect(resolveAiKind({}, { CODEX_HOME: "/x" })).toBe("codex");
    expect(resolveAiKind({}, {})).toBe("human");
    expect(() => resolveAiKind({ ai: "gpt" }, {})).toThrow(/--ai/);
  });
  it("reads the token's expiry without trusting its claims", () => {
    expect(tokenExpiry(GOOD)).toBe(Math.floor(NOW / 1000) * 1000 + 3_600_000);
    expect(tokenExpiry("not-a-jwt")).toBeNull();
    expect(gcloudTokenSource({ NIHO_OPS_ID_TOKEN: ` ${GOOD} ` })).toBe(GOOD);
  });
});

describe("api", () => {
  const make = (fetchImpl: typeof fetch, token = GOOD) => createApi({ env: { name: "stg", origin: "https://experience-stg.niho.life" }, aiKind: "claude-code", environment: {}, tokenSource: () => token, fetch: fetchImpl, now: () => NOW });
  it("sends the Bearer token, the AI kind and, for a change, the operation ID, and parses JSON", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ saved: 1 }), { status: 200 }));
    const api = make(fetchImpl as never);
    expect(await api.send("PUT", "/admin/api/product-classifications", { items: [] }, "op-20261114-abcdef")).toEqual({ status: 200, body: { saved: 1 } });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://experience-stg.niho.life/admin/api/product-classifications");
    expect(init.headers).toMatchObject({ authorization: `Bearer ${GOOD}`, "x-niho-operator-ai": "claude-code", "x-niho-operation-id": "op-20261114-abcdef", "content-type": "application/json" });
    await api.get("/admin/api/people");
    expect((fetchImpl.mock.calls[1] as unknown as [string, RequestInit])[1].headers).not.toHaveProperty("x-niho-operation-id");
  });
  it("calls /admin/api only, refuses an expired token, and never lets the token into an error", async () => {
    const api = make((async () => new Response("{}")) as never);
    await expect(api.get("/admin/bookings")).rejects.toMatchObject({ code: "usage" });
    await expect(api.get("/host/api/products")).rejects.toMatchObject({ code: "usage" });
    await expect(make((async () => new Response("{}")) as never, jwt(Math.floor(NOW / 1000) - 10)).get("/admin/api/people")).rejects.toMatchObject({ code: "token_expired", exit: EXIT.auth });
    await expect(make((async () => { throw new Error(`boom ${GOOD}`); }) as never).get("/admin/api/people")).rejects.toSatisfy((error: OpsError) => !error.message.includes(GOOD) && error.code === "unreachable");
  });
});

describe("diffValues and operationId", () => {
  it("lists each changed leaf, treats arrays as one value and ignores key order", () => {
    expect(diffValues({ a: 1, b: { c: [1, 2], d: "x" } }, { b: { d: "x", c: [1, 3] }, a: 1 })).toEqual([{ path: "b.c", before: [1, 2], after: [1, 3] }]);
    expect(diffValues({ a: 1 }, { a: 1, b: null })).toEqual([]);
    expect(diffValues({ a: 1 }, { a: 2, b: 3 })).toEqual([{ path: "a", before: 1, after: 2 }, { path: "b", before: null, after: 3 }]);
    expect(diffValues({ a: 1 }, { a: 1 })).toEqual([]);
  });
  it("gives the same ID to the same change and a new one to a retry", () => {
    const id = operationId(["file-hash", "p1/x1"], 1, NOW);
    expect(id).toMatch(/^op-20261114-[0-9a-f]{12}$/);
    expect(operationId(["file-hash", "p1/x1"], 1, NOW)).toBe(id);
    expect(operationId(["file-hash", "p1/x2"], 1, NOW)).not.toBe(id);
    expect(operationId(["file-hash", "p1/x1"], 2, NOW, () => "abc123")).toBe(`${id}-rabc123`);
    expect(operationId(["file-hash", "p1/x1"], 2, NOW)).toMatch(new RegExp(`^${id}-r[0-9a-f]{6}$`));
    expect(operationId(["file-hash", "p1/x1"], 2, NOW)).not.toBe(operationId(["file-hash", "p1/x1"], 2, NOW));
  });
});

describe("writeOne", () => {
  const context = (apply: boolean): Context => ({ api: {} as Api, args: { positional: [], flags: {} }, apply, env: "stg", readFile: () => "", readBytes: () => new Uint8Array(), now: () => NOW });
  const spec = (state: { value: number }, send: (op: string) => Promise<{ status: number; body: unknown }>) => ({
    key: "item", read: async () => ({ ...state }), desired: () => ({ value: 2 }), send: async (_c: unknown, _d: unknown, op: string) => send(op),
  });
  it("plans without sending unless --yes, and sends nothing when nothing differs", async () => {
    const send = vi.fn(async () => ({ status: 200, body: {} }));
    expect(await writeOne(context(false), ["seed"], spec({ value: 1 }, send))).toMatchObject({ status: "dry_run", changes: [{ path: "value", before: 1, after: 2 }] });
    expect(await writeOne(context(true), ["seed"], spec({ value: 2 }, send))).toMatchObject({ status: "unchanged" });
    expect(send).not.toHaveBeenCalled();
    expect(await writeOne(context(true), ["seed"], spec({ value: 1 }, send))).toMatchObject({ status: "applied" });
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("re-reads after the server refused a repeated operation ID: done already is unchanged, otherwise it retries under a new ID", async () => {
    const state = { value: 1 };
    const ids: string[] = [];
    const send = async (op: string) => {
      ids.push(op);
      if (ids.length === 1) { state.value = 2; return { status: 409, body: { error: "operation_already_recorded" } }; }
      return { status: 200, body: {} };
    };
    expect(await writeOne(context(true), ["seed"], spec(state, send))).toMatchObject({ status: "unchanged" });
    const state2 = { value: 1 };
    const ids2: string[] = [];
    const send2 = async (op: string) => { ids2.push(op); return ids2.length === 1 ? { status: 409, body: { error: "operation_already_recorded" } } : { status: 200, body: {} }; };
    expect(await writeOne(context(true), ["seed"], spec(state2, send2))).toMatchObject({ status: "applied" });
    expect(ids2[1]).toMatch(new RegExp(`^${ids2[0]}-r[0-9a-f]{6}$`));
  });
  it("reports another refusal as failed with the server's code", async () => {
    expect(await writeOne(context(true), ["seed"], spec({ value: 1 }, async () => ({ status: 400, body: { error: "invalid_input" } })))).toMatchObject({ status: "failed", error: "invalid_input" });
  });
});

describe("run", () => {
  const runtime = (status: number, body: unknown): Runtime => ({
    environment: {}, now: () => NOW, tokenSource: () => GOOD,
    fetch: (async () => new Response(JSON.stringify(body), { status })) as never,
  });
  it("lists the targets and actions with their tier", async () => {
    const out = await run(["help"], { environment: {} });
    expect(out.exit).toBe(0);
    expect(JSON.stringify(out.output)).toContain('"auth"');
  });
  it("checks the sign-in and prints a count, not the products", async () => {
    const out = await run(["auth", "check"], runtime(200, { products: [{ name: "private" }, {}] }));
    expect(out).toEqual({ exit: 0, output: { ok: true, env: "stg", target: "auth", action: "check", tier: "read", mode: "read", result: { signedIn: true, aiKind: "human", productCount: 2 } } });
  });
  it("maps a refusal to an exit code: 401/403 not signed in, 404 CLI closed, bad usage", async () => {
    expect((await run(["auth", "check"], runtime(401, { error: "unauthenticated" }))).exit).toBe(EXIT.auth);
    expect((await run(["auth", "check"], runtime(403, { error: "forbidden" }))).exit).toBe(EXIT.auth);
    expect(await run(["auth", "check"], runtime(404, { error: "not_found" }))).toMatchObject({ exit: EXIT.failed, output: { error: "cli_not_open" } });
    expect((await run(["nope", "x"], runtime(200, {}))).exit).toBe(EXIT.usage);
    expect((await run(["auth", "check", "--yes", "--dry-run"], runtime(200, {}))).exit).toBe(EXIT.usage);
    expect((await run(["auth", "check", "--env", "dev"], runtime(200, {}))).exit).toBe(EXIT.usage);
  });
});
