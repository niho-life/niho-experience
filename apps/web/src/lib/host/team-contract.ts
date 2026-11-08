import type { HostTeamMutationResult, HostTeamSnapshot } from "@niho-experience/experience-store";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACCOUNT = /^hst_[0-9a-f]{32}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const ROLES = new Set(["OWNER", "COHOST", "EDITOR", "VIEWER"]);

const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).length === keys.length && keys.every((key) => key in value);
const version = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

export type HostTeamCommandBody = { readonly commandId: string; readonly expectedRevision: number };

export function parseTeamCommand(value: unknown): HostTeamCommandBody | null {
  if (!record(value) || !exact(value, ["commandId", "expectedRevision"]) || typeof value.commandId !== "string" || !UUID.test(value.commandId) || !version(value.expectedRevision)) return null;
  return { commandId: value.commandId.toLowerCase(), expectedRevision: value.expectedRevision as number };
}

export function parseTeamResolve(value: unknown): { readonly email: string } | null {
  return record(value) && exact(value, ["email"]) && typeof value.email === "string" && value.email.length <= 254 ? { email: value.email } : null;
}

function members(value: unknown) {
  if (!Array.isArray(value)) return null;
  const parsed = value.map((item) => {
    if (!record(item) || !exact(item, ["hostAccountId", "role", "label"]) || typeof item.hostAccountId !== "string" || !ACCOUNT.test(item.hostAccountId)
      || typeof item.role !== "string" || !ROLES.has(item.role) || typeof item.label !== "string") return null;
    return { hostAccountId: item.hostAccountId, role: item.role as "OWNER" | "COHOST" | "EDITOR" | "VIEWER", label: item.label };
  });
  return parsed.every((item) => item !== null) ? parsed as NonNullable<(typeof parsed)[number]>[] : null;
}

/** Strictly validates even successful HTTP responses; callers must never turn an unknown shape into UI success. */
export function parseTeamSnapshot(value: unknown): HostTeamSnapshot | null {
  if (!record(value) || !exact(value, ["contractVersion", "teamRevision", "members"]) || value.contractVersion !== 1 || !version(value.teamRevision)) return null;
  const parsed = members(value.members);
  return parsed ? { contractVersion: 1, teamRevision: value.teamRevision as number, members: parsed } : null;
}

export function parseTeamMutation(value: unknown): HostTeamMutationResult | null {
  if (!record(value) || !exact(value, ["contractVersion", "teamRevision", "members", "receipt"])) return null;
  const snapshot = parseTeamSnapshot({ contractVersion: value.contractVersion, teamRevision: value.teamRevision, members: value.members });
  const receipt = value.receipt;
  if (!snapshot || !record(receipt) || !exact(receipt, ["commandId", "operation", "fingerprint", "version", "repeated"])
    || typeof receipt.commandId !== "string" || !UUID.test(receipt.commandId)
    || (receipt.operation !== "ADD_COHOST" && receipt.operation !== "REMOVE_COHOST")
    || typeof receipt.fingerprint !== "string" || !SHA256.test(receipt.fingerprint)
    || !version(receipt.version) || (receipt.version as number) < 1 || typeof receipt.repeated !== "boolean") return null;
  return { ...snapshot, receipt: { commandId: receipt.commandId, operation: receipt.operation, fingerprint: receipt.fingerprint, version: receipt.version as number, repeated: receipt.repeated } };
}

export function teamMutationMatchesCommand(
  result: HostTeamMutationResult,
  command: { readonly commandId: string; readonly operation: "add" | "remove"; readonly target: string },
): boolean {
  const expectedOperation = command.operation === "add" ? "ADD_COHOST" : "REMOVE_COHOST";
  const targetIsCohost = result.members.some((member) => member.hostAccountId === command.target && member.role === "COHOST");
  return result.receipt.commandId === command.commandId
    && result.receipt.operation === expectedOperation
    && result.receipt.version === result.teamRevision
    && (command.operation === "add" ? targetIsCohost : !targetIsCohost);
}

export function parseTeamResolveResult(value: unknown): { readonly contractVersion: 1; readonly teamRevision: number; readonly candidate: { readonly hostAccountId: string; readonly label: string } | null } | null {
  if (!record(value) || !exact(value, ["contractVersion", "teamRevision", "candidate"]) || value.contractVersion !== 1 || !version(value.teamRevision)) return null;
  if (value.candidate === null) return { contractVersion: 1, teamRevision: value.teamRevision as number, candidate: null };
  const candidate = value.candidate;
  if (!record(candidate) || !exact(candidate, ["hostAccountId", "label"]) || typeof candidate.hostAccountId !== "string" || !ACCOUNT.test(candidate.hostAccountId) || typeof candidate.label !== "string") return null;
  return { contractVersion: 1, teamRevision: value.teamRevision as number, candidate: { hostAccountId: candidate.hostAccountId, label: candidate.label } };
}
