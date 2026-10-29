import { randomUUID } from "node:crypto";
import { readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { atomicPrivateJson } from "./private-fs.mjs";
import { ContractError, exactKeys, isPlainObject } from "./validation.mjs";

const PHASES = ["CLAIMED", "RUNNING", "PENDING_RESULT", "QUARANTINED"];

function validateRecord(value) {
  if (!exactKeys(value, ["version", "phase", "journalId", "createdAtUtc", "updatedAtUtc", "job"], ["result", "reason", "reservationPage"])
    || value.version !== 1 || !PHASES.includes(value.phase) || typeof value.journalId !== "string"
    || typeof value.createdAtUtc !== "string" || typeof value.updatedAtUtc !== "string" || !isPlainObject(value.job)) {
    throw new ContractError("INVALID_JOURNAL");
  }
  if (value.phase === "PENDING_RESULT" && !isPlainObject(value.result)) throw new ContractError("INVALID_JOURNAL");
  return value;
}

export function createJournal(privateDir, now = () => new Date()) {
  const path = join(privateDir, "worker-journal.json");
  let current = null;
  const persist = async () => atomicPrivateJson(path, current);
  return Object.freeze({
    path,
    get current() { return current; },
    async load() {
      try { current = validateRecord(JSON.parse(await readFile(path, "utf8"))); }
      catch (error) {
        if (error?.code === "ENOENT") return null;
        if (error instanceof ContractError) throw error;
        throw new ContractError("INVALID_JOURNAL");
      }
      return current;
    },
    async claimed(job) {
      if (current) throw new ContractError("JOURNAL_NOT_EMPTY");
      const stamp = now().toISOString();
      current = { version: 1, phase: "CLAIMED", journalId: randomUUID(), createdAtUtc: stamp, updatedAtUtc: stamp, job };
      await persist();
      return current;
    },
    async running() {
      if (!current || current.phase !== "CLAIMED") throw new ContractError("INVALID_JOURNAL_TRANSITION");
      current = { ...current, phase: "RUNNING", updatedAtUtc: now().toISOString() };
      await persist();
    },
    async pendingResult(result, reason) {
      if (!current || !["CLAIMED", "RUNNING", "QUARANTINED"].includes(current.phase)) throw new ContractError("INVALID_JOURNAL_TRANSITION");
      current = { ...current, phase: "PENDING_RESULT", result, ...(reason ? { reason: String(reason).slice(0, 80) } : {}), updatedAtUtc: now().toISOString() };
      await persist();
      return current;
    },
    async pendingReservationPage(page) {
      if (!current || current.phase !== "RUNNING" || !isPlainObject(page)) throw new ContractError("INVALID_JOURNAL_TRANSITION");
      current = { ...current, reservationPage: page, updatedAtUtc: now().toISOString() };
      await persist();
    },
    async reservationPageAcknowledged(receiptId) {
      if (!current || current.phase !== "RUNNING" || current.reservationPage?.receiptId !== receiptId) {
        throw new ContractError("INVALID_JOURNAL_TRANSITION");
      }
      const { reservationPage: _discarded, ...rest } = current;
      current = { ...rest, updatedAtUtc: now().toISOString() };
      await persist();
    },
    async quarantine(reason) {
      if (!current || current.phase === "PENDING_RESULT") throw new ContractError("INVALID_JOURNAL_TRANSITION");
      current = { ...current, phase: "QUARANTINED", reason: String(reason).slice(0, 80), updatedAtUtc: now().toISOString() };
      await persist();
      return current;
    },
    async clearAfterAcknowledged(expectedResultId) {
      if (!current || current.phase !== "PENDING_RESULT" || current.result.resultId !== expectedResultId) throw new ContractError("INVALID_JOURNAL_TRANSITION");
      await unlink(path);
      current = null;
    },
  });
}

export function restartDisposition(record) {
  if (!record) return "EMPTY";
  if (record.phase === "PENDING_RESULT") return "RETRY_IDENTICAL_RESULT";
  return "QUARANTINE_EXPLICIT_RECOVERY";
}
