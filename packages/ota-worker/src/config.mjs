import { constants as fsConstants } from "node:fs";
import { access, lstat, readFile, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { ContractError, exactKeys, isPlainObject } from "./validation.mjs";

const CONFIG_KEYS = ["cloudOrigin", "tokenFile", "privateDir", "accountProfiles", "browserExecutable", "mode"];
const OPTIONAL_KEYS = ["claudeExecutable", "debugScreenshots"];

async function assertPrivatePath(path, expectedType, mode) {
  const absolute = resolve(path);
  const stat = await lstat(absolute);
  if (expectedType === "file" ? !stat.isFile() : !stat.isDirectory()) throw new ContractError("INSECURE_PRIVATE_PATH");
  if ((stat.mode & 0o777) !== mode || stat.uid !== process.getuid()) throw new ContractError("INSECURE_PRIVATE_PATH");
  const canonical = await realpath(absolute);
  return absolute;
}

export async function loadConfig(configPath, options = {}) {
  const path = await realpath(await assertPrivatePath(configPath, "file", 0o600));
  const configDirectory = await realpath(await assertPrivatePath(dirname(path), "directory", 0o700));
  let raw;
  try {
    raw = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new ContractError("INVALID_CONFIG");
  }
  if (!exactKeys(raw, CONFIG_KEYS, OPTIONAL_KEYS) || !isPlainObject(raw.accountProfiles)) throw new ContractError("INVALID_CONFIG");
  const origin = new URL(raw.cloudOrigin);
  const localTest = options.allowLocalTestOrigin === true && origin.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname);
  if ((!localTest && origin.protocol !== "https:") || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== "/") {
    throw new ContractError("INVALID_CLOUD_ORIGIN");
  }
  const privateDir = await realpath(await assertPrivatePath(raw.privateDir, "directory", 0o700));
  const tokenFile = await realpath(await assertPrivatePath(raw.tokenFile, "file", 0o600));
  if (privateDir !== configDirectory || dirname(tokenFile) !== privateDir) throw new ContractError("INVALID_PRIVATE_LAYOUT");
  const profiles = {};
  for (const [accountId, profilePath] of Object.entries(raw.accountProfiles)) {
    if (!/^\d+$/.test(accountId) || typeof profilePath !== "string") throw new ContractError("INVALID_CONFIG");
    const expected = resolve(privateDir, "profiles", accountId);
    const candidate = join(await realpath(dirname(resolve(profilePath))), basename(profilePath));
    if (candidate !== expected) throw new ContractError("INVALID_PROFILE_MAPPING");
    profiles[accountId] = expected;
  }
  if (typeof raw.browserExecutable !== "string" || raw.browserExecutable.length < 1
    || !["deterministic", "claude-code"].includes(raw.mode)
    || (raw.mode === "claude-code" && (typeof raw.claudeExecutable !== "string" || raw.claudeExecutable.length < 1))) {
    throw new ContractError("INVALID_CONFIG");
  }
  await access(raw.browserExecutable, fsConstants.X_OK);
  if (raw.mode === "claude-code") await access(raw.claudeExecutable, fsConstants.X_OK);
  return Object.freeze({
    cloudOrigin: origin.origin,
    tokenFile,
    privateDir,
    accountProfiles: Object.freeze(profiles),
    browserExecutable: resolve(raw.browserExecutable),
    mode: raw.mode,
    ...(raw.claudeExecutable ? { claudeExecutable: resolve(raw.claudeExecutable) } : {}),
    debugScreenshots: raw.debugScreenshots === true,
  });
}

export async function readBearerToken(tokenFile) {
  await assertPrivatePath(tokenFile, "file", 0o600);
  const token = (await readFile(tokenFile, "utf8")).trim();
  if (!/^[A-Za-z0-9._~-]{32,300}$/.test(token)) throw new ContractError("INVALID_TOKEN_FILE");
  return token;
}
