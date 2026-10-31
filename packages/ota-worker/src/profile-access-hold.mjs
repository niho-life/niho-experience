import { constants as fsConstants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { ContractError, exactKeys } from "./validation.mjs";

export const PROFILE_ACCESS_HOLD = ".niho-access-hold.json";
export const PROFILE_ACCESS_HOLD_REASONS = Object.freeze([
  "BOT_CHALLENGE",
  "ACCESS_RESTRICTED",
  "RATE_LIMITED",
  "OWNER_PAUSED",
]);

const REASONS = new Set(PROFILE_ACCESS_HOLD_REASONS);
const MAX_HOLD_BYTES = 512;

function fail(code, cause) {
  const error = new ContractError(code);
  if (cause !== undefined) error.cause = cause;
  return error;
}

async function assertPrivateProfile(profile) {
  if (typeof profile !== "string" || !isAbsolute(profile)) throw fail("INSECURE_PROFILE");
  let details;
  try { details = await lstat(profile, { bigint: true }); }
  catch (error) { throw fail("INSECURE_PROFILE", error); }
  const canonical = await realpath(profile).catch(() => null);
  if (!details.isDirectory() || details.isSymbolicLink() || details.uid !== BigInt(process.getuid())
    || (details.mode & 0o777n) !== 0o700n || canonical !== profile) {
    throw fail("INSECURE_PROFILE");
  }
  return canonical;
}

function safeHoldFile(details) {
  return details.isFile() && details.nlink === 1n && details.uid === BigInt(process.getuid())
    && (details.mode & 0o777n) === 0o600n && details.size > 0n && details.size <= BigInt(MAX_HOLD_BYTES);
}

function unchanged(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function validateHold(value) {
  if (!exactKeys(value, ["version", "reasonCode", "heldAtUtc"])
    || value.version !== 1 || !REASONS.has(value.reasonCode)
    || typeof value.heldAtUtc !== "string") throw fail("INVALID_PROFILE_ACCESS_HOLD");
  const heldAt = new Date(value.heldAtUtc);
  if (!Number.isFinite(heldAt.getTime()) || heldAt.toISOString() !== value.heldAtUtc) {
    throw fail("INVALID_PROFILE_ACCESS_HOLD");
  }
  return Object.freeze({ version: 1, reasonCode: value.reasonCode, heldAtUtc: value.heldAtUtc });
}

async function readBounded(handle) {
  const buffer = Buffer.alloc(MAX_HOLD_BYTES + 1);
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
    if (!Number.isSafeInteger(bytesRead) || bytesRead < 0 || bytesRead > buffer.length - offset) {
      throw fail("INVALID_PROFILE_ACCESS_HOLD");
    }
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  if (offset > MAX_HOLD_BYTES) throw fail("INVALID_PROFILE_ACCESS_HOLD");
  return buffer.subarray(0, offset).toString("utf8");
}

async function readHold(path) {
  let before;
  try { before = await lstat(path, { bigint: true }); }
  catch (error) {
    if (error?.code === "ENOENT") return null;
    throw fail("INVALID_PROFILE_ACCESS_HOLD", error);
  }
  if (!safeHoldFile(before) || await realpath(path).catch(() => null) !== path) {
    throw fail("INVALID_PROFILE_ACCESS_HOLD");
  }
  let handle;
  try {
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const opened = await handle.stat({ bigint: true });
    if (!safeHoldFile(opened) || !unchanged(before, opened)) throw fail("INVALID_PROFILE_ACCESS_HOLD");
    const raw = await readBounded(handle);
    const after = await handle.stat({ bigint: true });
    if (!unchanged(opened, after)) throw fail("INVALID_PROFILE_ACCESS_HOLD");
    return validateHold(JSON.parse(raw));
  } catch (error) {
    if (error instanceof ContractError) throw error;
    throw fail("INVALID_PROFILE_ACCESS_HOLD", error);
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function syncDirectory(profile) {
  const directory = await open(profile, "r");
  try { await directory.sync(); } finally { await directory.close(); }
}

export async function assertProfileAccessAvailable(profile) {
  const canonical = await assertPrivateProfile(profile);
  const hold = await readHold(join(canonical, PROFILE_ACCESS_HOLD));
  if (hold !== null) {
    const error = fail("PROFILE_ACCESS_HELD");
    error.reasonCode = hold.reasonCode;
    error.heldAtUtc = hold.heldAtUtc;
    throw error;
  }
  return true;
}

export async function holdProfileAccess(profile, reason) {
  const canonical = await assertPrivateProfile(profile);
  if (!REASONS.has(reason)) throw fail("INVALID_PROFILE_ACCESS_HOLD_REASON");
  const path = join(canonical, PROFILE_ACCESS_HOLD);
  const value = Object.freeze({ version: 1, reasonCode: reason, heldAtUtc: new Date().toISOString() });
  let handle;
  try {
    handle = await open(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await handle.sync();
    const written = await handle.stat({ bigint: true });
    if (!safeHoldFile(written)) throw fail("PROFILE_ACCESS_HOLD_WRITE_FAILED");
    await handle.close();
    handle = undefined;
    await syncDirectory(canonical);
    const confirmed = await readHold(path);
    if (confirmed.reasonCode !== reason || confirmed.heldAtUtc !== value.heldAtUtc) {
      throw fail("PROFILE_ACCESS_HOLD_WRITE_FAILED");
    }
    return confirmed;
  } catch (error) {
    await handle?.close().catch(() => {});
    if (error?.code === "EEXIST") {
      const existing = await readHold(path);
      if (existing !== null) return existing;
    }
    if (error instanceof ContractError) throw error;
    throw fail("PROFILE_ACCESS_HOLD_WRITE_FAILED", error);
  }
}

export const profileAccessHoldInternals = Object.freeze({ MAX_HOLD_BYTES, safeHoldFile, validateHold, readBounded, readHold });
