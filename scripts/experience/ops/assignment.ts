import { EXIT, OpsError, errorCode, failureOf, type Action, type Target } from "./core.ts";
import { stableCommandId } from "./product.ts";

/*
 * 開催回の担当 (#535, docs/occurrence-assignments.md) on behalf of someone, from the command line: `/admin/api/occurrence-assignments`.
 * Who takes an occurrence is recorded (claim, decline, release); the agreed fee (報酬) is not: the server refuses `SET_FEE`
 * from the CLI, so money stays with a person on the screen.
 */

const API = "/admin/api/occurrence-assignments";
const ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/;

function need(context: Parameters<Action["run"]>[0], flag: string): string {
  const value = context.args.flags[flag];
  if (typeof value !== "string" || !ID.test(value)) throw new OpsError("usage", `--${flag} <id> is required.`, EXIT.usage);
  return value;
}

const list: Action = {
  tier: "read",
  summary: "The occurrences with their assignee, or (--provider, --occurrence) the candidates and the whole history of one occurrence.",
  async run(context) {
    const provider = context.args.flags.provider;
    const occurrence = context.args.flags.occurrence;
    if ((provider === undefined) !== (occurrence === undefined)) throw new OpsError("usage", "Give both --provider and --occurrence, or neither.", EXIT.usage);
    const path = provider === undefined ? API : `${API}?providerId=${encodeURIComponent(need(context, "provider"))}&occurrenceId=${encodeURIComponent(need(context, "occurrence"))}`;
    const response = await context.api.get(path);
    if (response.status !== 200) throw failureOf(response, "assignment list");
    return response.body;
  },
};

function record(action: "CLAIM" | "DECLINE" | "RELEASE", summary: string): Action {
  return {
    tier: "edit",
    summary,
    async run(context) {
      const providerId = need(context, "provider");
      const occurrenceId = need(context, "occurrence");
      const subject = action === "RELEASE" ? undefined : need(context, "subject");
      const reason = context.args.flags.reason;
      if (reason !== undefined && typeof reason !== "string") throw new OpsError("usage", "--reason needs text.", EXIT.usage);
      const commandId = stableCommandId("assignment", action, providerId, occurrenceId, subject ?? "", String(reason ?? ""));
      const body = { action, providerId, occurrenceId, commandId, ...(subject ? { subjectNihoUserId: subject } : {}), ...(typeof reason === "string" ? { reason } : {}) };
      if (!context.apply) return { status: "dry_run", record: body };
      const day = new Date(context.now()).toISOString().slice(0, 10).replaceAll("-", "");
      const response = await context.api.send("POST", API, body, `op-${day}-${commandId.replaceAll("-", "").slice(0, 12)}`);
      if (response.status === 409 && errorCode(response.body) === "operation_already_recorded") return { status: "unchanged", note: "This was already sent; `assignment list --provider --occurrence` shows the history." };
      if (response.status === 409 && errorCode(response.body) === "already_assigned") return { status: "failed", error: "already_assigned", note: "Somebody else holds this occurrence: read the list again.", result: response.body };
      if (response.status < 200 || response.status >= 300) throw failureOf(response, `assignment ${action.toLowerCase()}`);
      return { status: "applied", result: response.body };
    },
  };
}

export const assignmentTarget: Target = {
  summary: "Occurrence assignments: who takes an occurrence (claim, decline, release on someone's behalf). Fees are not handled here.",
  actions: {
    list,
    claim: record("CLAIM", "Records that a person takes an occurrence (--provider, --occurrence, --subject <niho user id>, --reason? ). Refused when someone else holds it."),
    decline: record("DECLINE", "Records that a person declines an occurrence (--provider, --occurrence, --subject, --reason?)."),
    release: record("RELEASE", "Releases the current assignee of an occurrence (--provider, --occurrence, --reason?)."),
  },
};
