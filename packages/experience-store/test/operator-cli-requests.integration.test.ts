import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import { StoreValidationError } from "../src/errors.ts";
import { adminActorIdForGoogleSubject } from "../src/admin-sessions.ts";
import { OperatorCliRequests, type OperatorCliRequestInput } from "../src/operator-cli-requests.ts";
import { createIsolatedDatabase } from "./helpers/isolated-database.ts";

/** 運営の CLI (#576, migration 0078): the audit rows and the one-operation-once rule against a real schema, synthetic data only. */
const databaseUrl = process.env.TEST_DATABASE_URL;
const ADMIN = adminActorIdForGoogleSubject("100000000000000000001");
const OTHER = adminActorIdForGoogleSubject("100000000000000000002");
const BODY = createHash("sha256").update('{"items":[]}').digest("hex");
const base: OperatorCliRequestInput = {
  adminActorId: ADMIN,
  operationId: "op-20261114-0001",
  aiKind: "claude-code",
  method: "PUT",
  path: "/admin/api/product-classifications",
  bodySha256: BODY,
  nowUtc: "2026-11-14T00:00:00.000Z",
};

describe("operator CLI requests", { skip: !databaseUrl }, () => {
  it("records who, through which AI, which operation and the body's hash, and refuses the same operation ID a second time", async () => {
    const db = await createIsolatedDatabase(databaseUrl, "operator_cli", { max: 2 });
    try {
      const requests = new OperatorCliRequests(db.pool);
      const first = await requests.record(base);
      assert.equal(first.status, "recorded");
      const row = (await db.pool.query("SELECT admin_actor_id, operation_id, ai_kind, http_method, request_path, encode(body_sha256, 'hex') AS sha, recorded_at FROM operator_cli_requests WHERE request_ref = $1::uuid", [first.requestRef])).rows[0]!;
      assert.deepEqual({ ...row, recorded_at: (row.recorded_at as Date).toISOString() }, {
        admin_actor_id: ADMIN, operation_id: base.operationId, ai_kind: "claude-code", http_method: "PUT", request_path: base.path, sha: BODY, recorded_at: base.nowUtc,
      });
      assert.equal((await requests.record(base)).status, "duplicate");
      assert.equal((await requests.record({ ...base, bodySha256: createHash("sha256").update("other").digest("hex") })).status, "duplicate", "the operation ID decides, not the body");
      assert.equal((await requests.record({ ...base, adminActorId: OTHER })).status, "recorded", "another admin's operation IDs are their own");
      assert.equal((await requests.record({ ...base, operationId: "op-20261114-0002", aiKind: "codex" })).status, "recorded");
      assert.equal((await requests.record({ ...base, operationId: "op-20261114-0003", method: "PATCH", path: "/write/api/guides/abc" })).status, "recorded", "articles are written through /write/api");
      assert.equal(Number((await db.pool.query("SELECT count(*) AS n FROM operator_cli_requests")).rows[0]!.n), 4);
    } finally {
      await db.dispose();
    }
  });

  it("refuses a malformed input before it reaches the table", async () => {
    const db = await createIsolatedDatabase(databaseUrl, "operator_cli_bad", { max: 2 });
    try {
      const requests = new OperatorCliRequests(db.pool);
      const bad: Array<Partial<OperatorCliRequestInput>> = [
        { adminActorId: "adm_x" }, { operationId: "short" }, { operationId: "has space in it" }, { aiKind: "gpt" as never },
        { method: "GET" as never }, { path: "/admin/bookings" }, { path: "/write/guides" }, { path: "/admin/api/x?y=1 z" }, { bodySha256: "ABC" }, { nowUtc: "2026-11-14" },
      ];
      for (const patch of bad) await assert.rejects(() => requests.record({ ...base, ...patch }), StoreValidationError, JSON.stringify(patch));
      assert.equal(Number((await db.pool.query("SELECT count(*) AS n FROM operator_cli_requests")).rows[0]!.n), 0);
    } finally {
      await db.dispose();
    }
  });
});
