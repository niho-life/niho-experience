import { describe, expect, it } from "vitest";
import { parseTeamCommand, parseTeamMutation, parseTeamResolve, parseTeamResolveResult, parseTeamSnapshot, teamMutationMatchesCommand } from "./team-contract";

const HOST = `hst_${"1a".repeat(16)}`;
const COMMAND = "10000000-0000-4000-8000-000000000001";
const SNAPSHOT = { contractVersion: 1, teamRevision: 2, members: [{ hostAccountId: HOST, role: "COHOST", label: "ホスト 1a1a1a" }] };

describe("native host team contract v1", () => {
  it("accepts only exact command and resolve request shapes", () => {
    expect(parseTeamCommand({ commandId: COMMAND, expectedRevision: 2 })).toEqual({ commandId: COMMAND, expectedRevision: 2 });
    expect(parseTeamCommand({ commandId: COMMAND, expectedRevision: 2, target: HOST })).toBeNull();
    expect(parseTeamCommand({ commandId: "not-a-command", expectedRevision: 2 })).toBeNull();
    expect(parseTeamResolve({ email: "candidate@example.test" })).toEqual({ email: "candidate@example.test" });
    expect(parseTeamResolve({ email: "candidate@example.test", partial: true })).toBeNull();
  });

  it("strictly validates successful list, resolve and mutation DTOs", () => {
    expect(parseTeamSnapshot(SNAPSHOT)).toEqual(SNAPSHOT);
    expect(parseTeamSnapshot({ ...SNAPSHOT, providerId: "leak" })).toBeNull();
    expect(parseTeamSnapshot({ ...SNAPSHOT, members: [{ ...SNAPSHOT.members[0], email: "private@example.test" }] })).toBeNull();
    expect(parseTeamResolveResult({ contractVersion: 1, teamRevision: 2, candidate: { hostAccountId: HOST, label: "ホスト 1a1a1a" } })).not.toBeNull();
    expect(parseTeamResolveResult({ contractVersion: 1, teamRevision: 2, candidate: { hostAccountId: HOST, label: "x", email: "private@example.test" } })).toBeNull();
    const mutation = {
      ...SNAPSHOT,
      receipt: { commandId: COMMAND, operation: "ADD_COHOST", fingerprint: "a".repeat(64), version: 2, repeated: false },
    };
    expect(parseTeamMutation(mutation)).toEqual(mutation);
    const parsed = parseTeamMutation(mutation)!;
    expect(teamMutationMatchesCommand(parsed, { commandId: COMMAND, operation: "add", target: HOST })).toBe(true);
    expect(teamMutationMatchesCommand({ ...parsed, teamRevision: 3 }, { commandId: COMMAND, operation: "add", target: HOST })).toBe(false);
    expect(teamMutationMatchesCommand(parsed, { commandId: COMMAND, operation: "remove", target: HOST })).toBe(false);
    expect(teamMutationMatchesCommand({ ...parsed, members: [] }, { commandId: COMMAND, operation: "add", target: HOST })).toBe(false);
    expect(parseTeamMutation({ ...mutation, receipt: { ...mutation.receipt, snapshot: { email: "private@example.test" } } })).toBeNull();
  });
});
