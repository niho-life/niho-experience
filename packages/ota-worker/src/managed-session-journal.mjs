import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open, opendir, realpath, unlink } from "node:fs/promises";
import { join } from "node:path";
import { atomicPrivateJson } from "./private-fs.mjs";
import { ContractError, exactKeys } from "./validation.mjs";

export const MANAGED_SESSION_JOURNAL = ".niho-managed-session.json";
export const MANAGED_SESSION_LOCK = ".niho-managed-session.lock";

const MAX_SESSION_FILE_BYTES = 2_048;
const MAX_PREFERENCES_BYTES = 4 * 1_024 * 1_024;
const MAX_SESSION_ARTIFACT_BYTES = 32 * 1_024 * 1_024;
const MAX_SESSION_ARTIFACT_TOTAL_BYTES = 64 * 1_024 * 1_024;
const MAX_SESSION_ARTIFACTS = 64;
const MAX_PROFILE_ROOT_ENTRIES = 512;
const HASH_BUFFER_BYTES = 64 * 1_024;
const PROFILE_STATE_HASH = /^[0-9a-f]{64}$/;
const SESSION_ARTIFACT_NAME = /^(?:Session|Tabs)_\d+$/;
const ADDITIONAL_PROFILE_NAME = /^(?:Profile \d+|Guest Profile)$/;
const SESSION_POLICIES = new Set(["none", "prepare", "restore"]);

function validatePrivateFileDetails(details) {
  return details.isFile() && details.nlink === 1 && details.uid === process.getuid()
    && (details.mode & 0o777) === 0o600 && details.size > 0 && details.size <= MAX_SESSION_FILE_BYTES;
}

async function syncDirectory(path) {
  const directory = await open(path, "r");
  try { await directory.sync(); } finally { await directory.close(); }
}

async function assertPrivateProfile(profile) {
  let details;
  try { details = await lstat(profile); } catch { throw new ContractError("INSECURE_PROFILE"); }
  const canonical = await realpath(profile).catch(() => null);
  if (!details.isDirectory() || details.isSymbolicLink() || details.uid !== process.getuid()
    || (details.mode & 0o777) !== 0o700 || canonical !== profile) {
    throw new ContractError("INSECURE_PROFILE");
  }
  return canonical;
}

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function unchangedFile(left, right) {
  return sameFile(left, right) && left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function directoryShape(entries) {
  if (entries === null) return "MISSING";
  return JSON.stringify(entries.map((entry) => [
    entry.name,
    entry.isFile() ? "file" : entry.isDirectory() ? "directory" : entry.isSymbolicLink() ? "symlink" : "other",
  ]).sort((left, right) => left[0].localeCompare(right[0])));
}

function safeOwnedFile(details, maxBytes) {
  return details.isFile() && details.nlink === 1n && details.uid === BigInt(process.getuid())
    && (details.mode & 0o022n) === 0n && details.size >= 0n && details.size <= BigInt(maxBytes);
}

async function assertSafeDirectory(path, allowMissing = false) {
  let details;
  try { details = await lstat(path, { bigint: true }); }
  catch (error) {
    if (allowMissing && error?.code === "ENOENT") return null;
    throw new ContractError("INSECURE_PROFILE_STATE");
  }
  const canonical = await realpath(path).catch(() => null);
  if (!details.isDirectory() || details.isSymbolicLink() || details.uid !== BigInt(process.getuid())
    || (details.mode & 0o022n) !== 0n || canonical !== path) {
    throw new ContractError("INSECURE_PROFILE_STATE");
  }
  return details;
}

async function listSafeDirectory(path, maxEntries, allowMissing = false) {
  const before = await assertSafeDirectory(path, allowMissing);
  if (before === null) return null;
  const entries = [];
  let directory;
  try {
    directory = await opendir(path);
    for await (const entry of directory) {
      if (entries.length >= maxEntries) throw new ContractError("PROFILE_STATE_LIMIT");
      entries.push(entry);
    }
    directory = undefined;
  } catch (error) {
    await directory?.close().catch(() => {});
    if (error instanceof ContractError) throw error;
    throw new ContractError("INSECURE_PROFILE_STATE");
  }
  const after = await assertSafeDirectory(path);
  if (!unchangedFile(before, after)) throw new ContractError("PROFILE_STATE_RACE");
  return entries;
}

async function hashSafeOwnedFile(path, maxBytes) {
  let before;
  try { before = await lstat(path, { bigint: true }); }
  catch { throw new ContractError("INSECURE_PROFILE_STATE"); }
  if (!safeOwnedFile(before, maxBytes) || await realpath(path).catch(() => null) !== path) {
    throw new ContractError(before.size > BigInt(maxBytes) ? "PROFILE_STATE_LIMIT" : "INSECURE_PROFILE_STATE");
  }
  let handle;
  try {
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const opened = await handle.stat({ bigint: true });
    if (!safeOwnedFile(opened, maxBytes) || !unchangedFile(before, opened)) {
      throw new ContractError("PROFILE_STATE_RACE");
    }
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(HASH_BUFFER_BYTES);
    const size = Number(opened.size);
    let offset = 0;
    while (offset < size) {
      const length = Math.min(buffer.length, size - offset);
      const { bytesRead } = await handle.read(buffer, 0, length, offset);
      if (bytesRead < 1) throw new ContractError("PROFILE_STATE_RACE");
      hash.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (!unchangedFile(opened, after)) throw new ContractError("PROFILE_STATE_RACE");
    return { size, hash: hash.digest("hex") };
  } catch (error) {
    if (error instanceof ContractError) throw error;
    throw new ContractError("INSECURE_PROFILE_STATE");
  } finally {
    await handle?.close().catch(() => {});
  }
}

export async function attestManagedProfile(profile) {
  const canonicalProfile = await assertPrivateProfile(profile);
  const rootEntries = await listSafeDirectory(canonicalProfile, MAX_PROFILE_ROOT_ENTRIES);
  const rootShape = directoryShape(rootEntries);
  if (rootEntries.some((entry) => ADDITIONAL_PROFILE_NAME.test(entry.name))) {
    throw new ContractError("MULTIPLE_CHROME_PROFILES");
  }
  const defaultProfile = join(canonicalProfile, "Default");
  const defaultBefore = await assertSafeDirectory(defaultProfile);
  const manifest = [];
  const preferences = await hashSafeOwnedFile(join(defaultProfile, "Preferences"), MAX_PREFERENCES_BYTES);
  manifest.push(["Default/Preferences", preferences.size, preferences.hash]);

  const sessionsPath = join(defaultProfile, "Sessions");
  const sessionEntries = await listSafeDirectory(sessionsPath, MAX_SESSION_ARTIFACTS, true);
  const sessionShape = directoryShape(sessionEntries);
  let totalBytes = 0;
  if (sessionEntries !== null) {
    for (const entry of sessionEntries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!SESSION_ARTIFACT_NAME.test(entry.name) || !entry.isFile()) {
        throw new ContractError("UNKNOWN_SESSION_ARTIFACT");
      }
      const artifact = await hashSafeOwnedFile(join(sessionsPath, entry.name), MAX_SESSION_ARTIFACT_BYTES);
      totalBytes += artifact.size;
      if (totalBytes > MAX_SESSION_ARTIFACT_TOTAL_BYTES) throw new ContractError("PROFILE_STATE_LIMIT");
      manifest.push([`Default/Sessions/${entry.name}`, artifact.size, artifact.hash]);
    }
  }
  const sessionsAfter = await listSafeDirectory(sessionsPath, MAX_SESSION_ARTIFACTS, true);
  const defaultAfter = await assertSafeDirectory(defaultProfile);
  const rootAfter = await listSafeDirectory(canonicalProfile, MAX_PROFILE_ROOT_ENTRIES);
  if (directoryShape(sessionsAfter) !== sessionShape || !unchangedFile(defaultBefore, defaultAfter)
    || directoryShape(rootAfter) !== rootShape) {
    throw new ContractError("PROFILE_STATE_RACE");
  }
  return createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
}

async function readPrivateJson(path) {
  let details;
  try { details = await lstat(path); }
  catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new ContractError("INSECURE_SESSION_FILE");
  }
  if (details.size > MAX_SESSION_FILE_BYTES) throw new ContractError("SESSION_FILE_TOO_LARGE");
  if (!validatePrivateFileDetails(details) || await realpath(path).catch(() => null) !== path) {
    throw new ContractError("INSECURE_SESSION_FILE");
  }

  let handle;
  try {
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const opened = await handle.stat();
    if (!validatePrivateFileDetails(opened) || opened.dev !== details.dev || opened.ino !== details.ino) {
      throw new ContractError("INSECURE_SESSION_FILE");
    }
    return JSON.parse(await handle.readFile("utf8"));
  } catch (error) {
    if (error instanceof ContractError) throw error;
    throw new ContractError("INVALID_SESSION_JOURNAL");
  } finally {
    await handle?.close().catch(() => {});
  }
}

function validateJournal(value, profile) {
  const keysValid = value?.phase === "CLEAN"
    ? exactKeys(value, ["version", "phase", "profile", "nonce", "profileStateHash"])
    : exactKeys(value, ["version", "phase", "profile", "nonce"]);
  if (!keysValid || value.version !== 1 || !["CLEAN", "DIRTY"].includes(value.phase)
    || typeof value.profile !== "string" || typeof value.nonce !== "string"
    || value.nonce.length < 1 || value.nonce.length > 128
    || (value.phase === "CLEAN" && !PROFILE_STATE_HASH.test(value.profileStateHash))) {
    throw new ContractError("INVALID_SESSION_JOURNAL");
  }
  if (value.profile !== profile) throw new ContractError("SESSION_PROFILE_MISMATCH");
  return value;
}

async function assertOwnLock(session) {
  const raw = await readPrivateJson(session.lockPath);
  if (raw === null) throw new ContractError("SESSION_LOCK_MISSING");
  const current = validateLock(raw, session.profile);
  if (current.nonce !== session.nonce) throw new ContractError("SESSION_LOCK_CHANGED");
  return current;
}

function validateLock(value, profile) {
  if (!exactKeys(value, ["version", "profile", "nonce"])
    || value.version !== 1 || value.profile !== profile || typeof value.nonce !== "string"
    || value.nonce.length < 1 || value.nonce.length > 128) {
    throw new ContractError("INVALID_SESSION_LOCK");
  }
  return value;
}

async function acquireLock(profile, path, nonce) {
  let handle;
  try {
    handle = await open(path, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify({ version: 1, profile, nonce })}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await syncDirectory(profile);
  } catch (error) {
    await handle?.close().catch(() => {});
    if (error?.code === "EEXIST") {
      const existing = await readPrivateJson(path);
      if (existing) validateLock(existing, profile);
      throw new ContractError("SESSION_LOCKED");
    }
    throw error;
  }
}

export function validateSessionPolicy(policy) {
  if (!SESSION_POLICIES.has(policy)) throw new ContractError("INVALID_SESSION_POLICY");
  return policy;
}

export async function beginManagedSession(profile, policy) {
  validateSessionPolicy(policy);
  if (policy === "none") throw new ContractError("SESSION_POLICY_NONE");
  const canonicalProfile = await assertPrivateProfile(profile);
  const journalPath = join(canonicalProfile, MANAGED_SESSION_JOURNAL);
  const lockPath = join(canonicalProfile, MANAGED_SESSION_LOCK);
  const nonce = randomUUID();
  await acquireLock(canonicalProfile, lockPath, nonce);

  let journal;
  try {
    const raw = await readPrivateJson(journalPath);
    journal = raw === null ? null : validateJournal(raw, canonicalProfile);
    if (policy === "restore" && journal === null) throw new ContractError("SESSION_JOURNAL_MISSING");
    if (journal?.phase === "DIRTY") throw new ContractError("SESSION_JOURNAL_DIRTY");
    if (policy === "restore" && await attestManagedProfile(canonicalProfile) !== journal.profileStateHash) {
      throw new ContractError("SESSION_PROFILE_CHANGED");
    }
    await atomicPrivateJson(journalPath, { version: 1, phase: "DIRTY", profile: canonicalProfile, nonce });
  } catch (error) {
    await releaseManagedSessionLock({ profile: canonicalProfile, lockPath, nonce }).catch(() => false);
    throw error;
  }

  return Object.freeze({
    profile: canonicalProfile,
    journalPath,
    lockPath,
    nonce,
    restore: policy === "restore" && journal?.phase === "CLEAN",
  });
}

export async function markManagedSessionClean(session) {
  const current = validateJournal(await readPrivateJson(session.journalPath), session.profile);
  if (current.phase !== "DIRTY" || current.nonce !== session.nonce) {
    throw new ContractError("SESSION_JOURNAL_CHANGED");
  }
  await assertOwnLock(session);
  const profileStateHash = await attestManagedProfile(session.profile);
  const confirmed = validateJournal(await readPrivateJson(session.journalPath), session.profile);
  if (confirmed.phase !== "DIRTY" || confirmed.nonce !== session.nonce) {
    throw new ContractError("SESSION_JOURNAL_CHANGED");
  }
  await assertOwnLock(session);
  await atomicPrivateJson(session.journalPath, {
    version: 1,
    phase: "CLEAN",
    profile: session.profile,
    nonce: session.nonce,
    profileStateHash,
  });
}

export async function releaseManagedSessionLock(session) {
  const raw = await readPrivateJson(session.lockPath);
  if (raw === null) return false;
  let current;
  try { current = validateLock(raw, session.profile); } catch { return false; }
  if (current.nonce !== session.nonce) return false;
  await unlink(session.lockPath);
  await syncDirectory(session.profile);
  return true;
}

export const managedSessionJournalInternals = Object.freeze({
  MAX_SESSION_FILE_BYTES,
  directoryShape,
  unchangedFile,
  validatePrivateFileDetails,
  readPrivateJson,
  validateJournal,
  validateLock,
  hashSafeOwnedFile,
  listSafeDirectory,
});
