import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { StoreValidationError } from "./errors.ts";
import { isAdminActorId, type AdminActorId } from "./admin-sessions.ts";
import { assertCanonicalInstant } from "./validation.ts";

/*
 * 運営の CLI (#576, migration 0078): the audit trail of what an admin changed from the command line, and what keeps the
 * same operation from running twice. The web layer verifies the Google ID token and the allowlist; this module only
 * records. The body is never kept, only its SHA-256. Nothing here logs.
 */

export const OPERATOR_AI_KINDS = ["claude-code", "codex", "other", "human"] as const;
export type OperatorAiKind = (typeof OPERATOR_AI_KINDS)[number];

export const OPERATOR_WRITE_METHODS = ["POST", "PUT", "PATCH", "DELETE"] as const;
export type OperatorWriteMethod = (typeof OPERATOR_WRITE_METHODS)[number];

const OPERATION_ID = /^[A-Za-z0-9._:-]{8,64}$/;
const PATH = /^\/admin\/api\/[\x21-\x7E]{1,500}$/;
const SHA256 = /^[0-9a-f]{64}$/;

export interface OperatorCliRequestInput {
  readonly adminActorId: AdminActorId;
  readonly operationId: string;
  readonly aiKind: OperatorAiKind;
  readonly method: OperatorWriteMethod;
  /** The request path without its query (`/admin/api/...`). */
  readonly path: string;
  /** Lower-case hex SHA-256 of the request body. */
  readonly bodySha256: string;
  readonly nowUtc: string;
}

export class OperatorCliRequests {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  /**
   * Records an operation before it runs. `duplicate` when this admin already sent this operation ID: the caller must
   * not run it again. Throws StoreValidationError for a malformed input.
   */
  async record(input: OperatorCliRequestInput): Promise<{ readonly status: "recorded" | "duplicate"; readonly requestRef: string }> {
    if (!isAdminActorId(input?.adminActorId)) throw new StoreValidationError("adminActorId must be an admin actor ID.");
    if (typeof input.operationId !== "string" || !OPERATION_ID.test(input.operationId)) throw new StoreValidationError("operationId must be 8-64 letters, digits or ._:-.");
    if (!(OPERATOR_AI_KINDS as readonly unknown[]).includes(input.aiKind)) throw new StoreValidationError("aiKind is not a known AI kind.");
    if (!(OPERATOR_WRITE_METHODS as readonly unknown[]).includes(input.method)) throw new StoreValidationError("method must be a write method.");
    if (typeof input.path !== "string" || !PATH.test(input.path)) throw new StoreValidationError("path must be an /admin/api path without a query.");
    if (typeof input.bodySha256 !== "string" || !SHA256.test(input.bodySha256)) throw new StoreValidationError("bodySha256 must be lower-case hex SHA-256.");
    assertCanonicalInstant(input.nowUtc, "nowUtc");
    const requestRef = randomUUID();
    const result = await this.#pool.query(
      `INSERT INTO operator_cli_requests (request_ref, admin_actor_id, operation_id, ai_kind, http_method, request_path, body_sha256, recorded_at)
       VALUES ($1::uuid, $2, $3, $4, $5, $6, decode($7, 'hex'), $8::timestamptz)
       ON CONFLICT (admin_actor_id, operation_id) DO NOTHING`,
      [requestRef, input.adminActorId, input.operationId, input.aiKind, input.method, input.path, input.bodySha256, input.nowUtc],
    );
    return { status: result.rowCount === 1 ? "recorded" : "duplicate", requestRef };
  }
}
