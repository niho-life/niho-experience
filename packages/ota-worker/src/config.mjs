import { constants as fsConstants } from "node:fs";
import { access, lstat, readFile, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { ContractError, exactKeys, isPlainObject } from "./validation.mjs";

const CONFIG_KEYS = ["cloudOrigin", "tokenFile", "privateDir", "accountProfiles", "browserExecutable", "mode"];
const OPTIONAL_KEYS = ["claudeExecutable", "debugScreenshots", "siteAccountProfiles", "siteAccountSessionPolicies", "googleDeliveryEnabled"];
const SITE_PROFILE_NAMESPACES = Object.freeze({ Viator: "viator", Jalan: "jalan" });

async function assertPrivatePath(path, expectedType, mode) {
  const absolute = resolve(path);
  const stat = await lstat(absolute);
  if (expectedType === "file" ? !stat.isFile() : !stat.isDirectory()) throw new ContractError("INSECURE_PRIVATE_PATH");
  if ((stat.mode & 0o777) !== mode || stat.uid !== process.getuid()) throw new ContractError("INSECURE_PRIVATE_PATH");
  const canonical = await realpath(absolute);
  if (canonical !== absolute) throw new ContractError("INSECURE_PRIVATE_PATH");
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
  if (!exactKeys(raw, CONFIG_KEYS, OPTIONAL_KEYS) || !isPlainObject(raw.accountProfiles)
    || (raw.siteAccountProfiles !== undefined && !isPlainObject(raw.siteAccountProfiles))) throw new ContractError("INVALID_CONFIG");
  const origin = new URL(raw.cloudOrigin);
  const localTest = options.allowLocalTestOrigin === true && origin.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname);
  if ((!localTest && origin.protocol !== "https:") || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== "/") {
    throw new ContractError("INVALID_CLOUD_ORIGIN");
  }
  const privateDir = await realpath(await assertPrivatePath(raw.privateDir, "directory", 0o700));
  const tokenFile = await realpath(await assertPrivatePath(raw.tokenFile, "file", 0o600));
  if (privateDir !== configDirectory || dirname(tokenFile) !== privateDir) throw new ContractError("INVALID_PRIVATE_LAYOUT");
  const profiles = {};
  const profilesRoot = await realpath(await assertPrivatePath(join(privateDir, "profiles"), "directory", 0o700));
  for (const [accountId, profilePath] of Object.entries(raw.accountProfiles)) {
    if (!/^\d+$/.test(accountId) || typeof profilePath !== "string") throw new ContractError("INVALID_CONFIG");
    const expected = resolve(privateDir, "profiles", accountId);
    const parent = await assertPrivatePath(dirname(resolve(profilePath)), "directory", 0o700);
    const candidate = join(parent, basename(profilePath));
    if (candidate !== expected) throw new ContractError("INVALID_PROFILE_MAPPING");
    profiles[accountId] = expected;
  }
  const siteAccountProfiles = {};
  for (const [site, mapping] of Object.entries(raw.siteAccountProfiles ?? {})) {
    const namespace = SITE_PROFILE_NAMESPACES[site];
    if (!namespace || !isPlainObject(mapping)) throw new ContractError("INVALID_CONFIG");
    const namespaceRoot = await realpath(await assertPrivatePath(join(profilesRoot, namespace), "directory", 0o700));
    const entries = {};
    for (const [accountId, profilePath] of Object.entries(mapping)) {
      const accountValid = site === "Viator" ? /^\d+$/.test(accountId) : /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(accountId);
      if (!accountValid || typeof profilePath !== "string") throw new ContractError("INVALID_CONFIG");
      const expected = resolve(namespaceRoot, accountId);
      const parent = await assertPrivatePath(dirname(resolve(profilePath)), "directory", 0o700);
      const candidate = join(parent, basename(profilePath));
      if (candidate !== expected) throw new ContractError("INVALID_PROFILE_MAPPING");
      entries[accountId] = expected;
    }
    siteAccountProfiles[site] = Object.freeze(entries);
  }
  const siteAccountSessionPolicies = {};
  if (raw.siteAccountSessionPolicies !== undefined && !isPlainObject(raw.siteAccountSessionPolicies)) throw new ContractError("INVALID_CONFIG");
  for (const [site, mapping] of Object.entries(raw.siteAccountSessionPolicies ?? {})) {
    // Session-cookie restoration is an explicit, account-specific opt-in. Only
    // the reviewed Jalan flow is supported; login preparation is never a job.
    if (site !== "Jalan" || !isPlainObject(mapping)) throw new ContractError("INVALID_CONFIG");
    const entries = {};
    for (const [accountId, policy] of Object.entries(mapping)) {
      if (!Object.hasOwn(siteAccountProfiles[site] ?? {}, accountId) || policy !== "restore") throw new ContractError("INVALID_CONFIG");
      entries[accountId] = policy;
    }
    siteAccountSessionPolicies[site] = Object.freeze(entries);
  }
  if (typeof raw.browserExecutable !== "string" || raw.browserExecutable.length < 1
    || !["deterministic", "claude-code"].includes(raw.mode)
    || (raw.googleDeliveryEnabled !== undefined && typeof raw.googleDeliveryEnabled !== "boolean")
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
    siteAccountProfiles: Object.freeze(siteAccountProfiles),
    siteAccountSessionPolicies: Object.freeze(siteAccountSessionPolicies),
    browserExecutable: resolve(raw.browserExecutable),
    mode: raw.mode,
    ...(raw.claudeExecutable ? { claudeExecutable: resolve(raw.claudeExecutable) } : {}),
    debugScreenshots: raw.debugScreenshots === true,
    googleDeliveryEnabled: raw.googleDeliveryEnabled === true,
  });
}

export function selectAccountProfile(config, target) {
  const profile = target.site === "GetYourGuide"
    ? config.accountProfiles?.[target.externalAccountId]
    : config.siteAccountProfiles?.[target.site]?.[target.externalAccountId];
  if (!profile) throw new ContractError("PROFILE_MAPPING_MISSING");
  return profile;
}

export function selectAccountSessionPolicy(config, target) {
  return config.siteAccountSessionPolicies?.[target.site]?.[target.externalAccountId] ?? "none";
}

export async function readBearerToken(tokenFile) {
  await assertPrivatePath(tokenFile, "file", 0o600);
  const token = (await readFile(tokenFile, "utf8")).trim();
  if (!/^[A-Za-z0-9._~-]{32,300}$/.test(token)) throw new ContractError("INVALID_TOKEN_FILE");
  return token;
}
