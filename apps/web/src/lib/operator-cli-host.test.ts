import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { run } from "../../../../scripts/experience/ops/main.ts";
import type { Api, ApiResponse } from "../../../../scripts/experience/ops/core.ts";

/* 運営の CLI (#711): the host list, host-wide suspension and host accounts, against an in-memory /admin/api/hosts. No network. */

const NOW = Date.parse("2026-11-28T00:00:00.000Z");
const ACCOUNT = `hst_${"b".repeat(32)}`;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = Record<string, any>;

function fakeApi() {
  let suspended: string | null = null;
  let accountStatus = "ACTIVE";
  const sent: Array<{ method: string; path: string; body: unknown; operationId: string }> = [];
  const hosts = () => [{
    providerId: "prv_1", publicDisplayName: "合成の会", publicPages: 2, sellingPages: 1,
    operationsSuspendedAtUtc: suspended ? "2026-11-28T00:00:00.000Z" : null, operationsSuspensionCode: suspended,
    owners: [{ hostAccountId: ACCOUNT, status: accountStatus, email: "owner@example.test" }],
  }];
  const api: Api = {
    env: "stg", aiKind: "claude-code",
    async get(path) { return path === "/admin/api/hosts" ? { status: 200, body: { hosts: hosts() } } : { status: 404, body: {} }; },
    async send(method, path, body, operationId): Promise<ApiResponse> {
      sent.push({ method, path, body, operationId });
      if (path === "/admin/api/hosts/prv_1/suspend") { suspended = (body as Loose).reasonCode; return { status: 200, body: { providerId: "prv_1", changed: true, suspendedProducts: 2 } }; }
      if (path === "/admin/api/hosts/prv_1/clear-suspension") { suspended = null; return { status: 200, body: { providerId: "prv_1", changed: true, suspendedProducts: 2 } }; }
      if (path === `/admin/api/hosts/accounts/${ACCOUNT}/suspend`) { accountStatus = "SUSPENDED"; return { status: 200, body: { hostAccountId: ACCOUNT, changed: true } }; }
      if (path === `/admin/api/hosts/accounts/${ACCOUNT}/reactivate`) { accountStatus = "ACTIVE"; return { status: 200, body: { hostAccountId: ACCOUNT, changed: true } }; }
      return { status: 404, body: {} };
    },
  };
  return { api, sent };
}
const exec = (api: Api, argv: string[]) => run(argv, { environment: {}, api, now: () => NOW });
const out = (outcome: Awaited<ReturnType<typeof run>>) => outcome.output as Loose;

describe("provider hosts / suspend / clear-suspension", () => {
  it("reads the host list", async () => {
    const fake = fakeApi();
    const outcome = out(await exec(fake.api, ["provider", "hosts"]));
    expect(outcome.tier).toBe("read");
    expect(outcome.result.hosts).toHaveLength(1);
    expect(fake.sent).toEqual([]);
  });

  it("shows what would stop without --yes, and sends once with it; a second run changes nothing", async () => {
    const fake = fakeApi();
    const plan = out(await exec(fake.api, ["provider", "suspend", "--provider", "prv_1", "--reason", "UNDER_REVIEW"]));
    expect(plan.mode).toBe("dry-run");
    expect(plan.result).toMatchObject({ status: "dry_run", wouldSuspend: { providerId: "prv_1", publicPages: 2, sellingPages: 1, reason: "UNDER_REVIEW" } });
    expect(fake.sent).toEqual([]);
    const applied = out(await exec(fake.api, ["provider", "suspend", "--provider", "prv_1", "--reason", "UNDER_REVIEW", "--yes"]));
    expect(applied.result.status).toBe("applied");
    expect(fake.sent).toHaveLength(1);
    expect(fake.sent[0]).toMatchObject({ method: "POST", path: "/admin/api/hosts/prv_1/suspend", body: { reasonCode: "UNDER_REVIEW" } });
    expect(out(await exec(fake.api, ["provider", "suspend", "--provider", "prv_1", "--reason", "UNDER_REVIEW", "--yes"])).result.status).toBe("unchanged");
    expect(fake.sent).toHaveLength(1);
  });

  it("refuses a missing or malformed reason, a missing provider and an unknown provider", async () => {
    const fake = fakeApi();
    expect((await exec(fake.api, ["provider", "suspend", "--provider", "prv_1"])).exit).toBe(2);
    expect((await exec(fake.api, ["provider", "suspend", "--provider", "prv_1", "--reason", "lower"])).exit).toBe(2);
    expect((await exec(fake.api, ["provider", "suspend", "--reason", "X"])).exit).toBe(2);
    expect(out(await exec(fake.api, ["provider", "suspend", "--provider", "prv_9", "--reason", "X"])).error).toBe("not_found");
  });

  it("lifts a suspension, and says there is nothing to lift when there is none", async () => {
    const fake = fakeApi();
    expect(out(await exec(fake.api, ["provider", "clear-suspension", "--provider", "prv_1", "--yes"])).result.status).toBe("unchanged");
    await exec(fake.api, ["provider", "suspend", "--provider", "prv_1", "--reason", "X", "--yes"]);
    expect(out(await exec(fake.api, ["provider", "clear-suspension", "--provider", "prv_1"])).result.status).toBe("dry_run");
    expect(out(await exec(fake.api, ["provider", "clear-suspension", "--provider", "prv_1", "--yes"])).result.status).toBe("applied");
    expect(fake.sent.at(-1)).toMatchObject({ path: "/admin/api/hosts/prv_1/clear-suspension" });
  });
});

describe("product suspend reserves PROVIDER_SUSPENDED", () => {
  it("refuses the code before reading or sending anything", async () => {
    const fake = fakeApi();
    expect((await exec(fake.api, ["product", "suspend", "--provider", "prv_1", "--product", "x1", "--reason", "PROVIDER_SUSPENDED", "--yes"])).exit).toBe(2);
    expect(fake.sent).toEqual([]);
  });
});

describe("host-account suspend / reactivate", () => {
  it("plans, applies and is idempotent", async () => {
    const fake = fakeApi();
    expect(out(await exec(fake.api, ["host-account", "suspend", "--account", ACCOUNT])).result).toMatchObject({ status: "dry_run", wouldSuspend: { accountId: ACCOUNT, current: "ACTIVE" } });
    expect(out(await exec(fake.api, ["host-account", "suspend", "--account", ACCOUNT, "--yes"])).result.status).toBe("applied");
    expect(out(await exec(fake.api, ["host-account", "suspend", "--account", ACCOUNT, "--yes"])).result.status).toBe("unchanged");
    expect(out(await exec(fake.api, ["host-account", "reactivate", "--account", ACCOUNT, "--yes"])).result.status).toBe("applied");
    expect(out(await exec(fake.api, ["host-account", "reactivate", "--account", ACCOUNT, "--yes"])).result.status).toBe("unchanged");
    expect(fake.sent.map((item) => item.path)).toEqual([`/admin/api/hosts/accounts/${ACCOUNT}/suspend`, `/admin/api/hosts/accounts/${ACCOUNT}/reactivate`]);
  });

  it("takes only an hst_ account ID", async () => {
    const fake = fakeApi();
    expect((await exec(fake.api, ["host-account", "suspend", "--account", "niho-user-1"])).exit).toBe(2);
    expect((await exec(fake.api, ["host-account", "suspend"])).exit).toBe(2);
  });

  it("is reachable from the CLI proxy (the hosts area is open)", async () => {
    const { operatorApiAllowed } = await import("@/lib/admin/operator-cli");
    expect(operatorApiAllowed("/admin/api/hosts")).toBe(true);
    expect(operatorApiAllowed(`/admin/api/hosts/accounts/${ACCOUNT}/suspend`)).toBe(true);
  });
});
