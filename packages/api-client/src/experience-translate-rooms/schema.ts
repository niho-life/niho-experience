import { Ajv, type ValidateFunction } from "ajv";
import addFormatsModule from "ajv-formats";
import contractDocument from "../../contract/experience-translate-rooms-api.openapi.json" with { type: "json" };
import { toJsonSchema } from "../public-schema-validation.ts";
import type {
  ExperienceTranslateRoomCreatedResponse,
  ExperienceTranslateRoomEndResponse,
  ExperienceTranslateRoomStatusResponse,
  StandaloneTranslateInvite,
  StandaloneTranslateInviteResult,
  StandaloneTranslateRoomCreated,
} from "./types.ts";

type JsonObject = Record<string, unknown>;
const addFormats = addFormatsModule as unknown as (ajv: Ajv) => Ajv;
const document = contractDocument as unknown as JsonObject;
const schemas = (document.components as JsonObject).schemas as JsonObject;
const ajv = new Ajv({ allErrors: true, strict: true, strictRequired: false });
addFormats(ajv);
const converted = JSON.parse(JSON.stringify(toJsonSchema(schemas)).replaceAll("contract#/$defs/", "experience-translate-rooms#/$defs/")) as JsonObject;
ajv.addSchema({ $id: "experience-translate-rooms", $defs: converted });
const compiled = new Map<string, ValidateFunction>();

function validator(name: string): ValidateFunction {
  const cached = compiled.get(name);
  if (cached) return cached;
  if (!(name in schemas)) throw new Error(`unknown experience translate rooms schema: ${name}`);
  const value = ajv.compile({ $ref: `experience-translate-rooms#/$defs/${name}` });
  compiled.set(name, value);
  return value;
}

export function isExperienceTranslateRoomsSchema<T>(name: string, value: unknown): value is T {
  return validator(name)(value) as boolean;
}

/** A path segment NIHO can take as an id: the same rule as the provider operations contract. */
export const isExperienceTranslateRoomPathId = (value: unknown): value is string =>
  typeof value === "string" && value.length >= 1 && value.length <= 200 && value !== "." && value !== ".." && !/[/\\%\u0000-\u001f\u007f]/.test(value);

/** Standalone room ids use the contract's tighter 128-character bound. */
export const isStandaloneTranslateRoomId = (value: unknown): value is string =>
  isExperienceTranslateRoomPathId(value) && value.length <= 128;

export const isExperienceTranslateBookingId = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);

const STANDALONE_INVITE_HOSTS = new Set(["niho.life", "app.niho.life", "app-stg.niho.life"]);
const STANDALONE_INVITE_CODE = /^[A-Za-z0-9_-]{32,64}$/;
const STANDALONE_INVITE_URL = /^(https:\/\/(?:niho\.life|app\.niho\.life|app-stg\.niho\.life)\/t)#([A-Za-z0-9_-]{32,64})$/;

/** Only NIHO's native translate deep link may cross from the upstream response into a browser href/QR. */
export function isStandaloneTranslateInviteUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 512 || /[\s\u0000-\u001f\u007f]/u.test(value)) return false;
  // Parse only after the raw spelling is exact. URL() normalizes dot segments and some
  // whitespace/control characters, while the native route accepts the literal `/t` only.
  const match = STANDALONE_INVITE_URL.exec(value);
  if (!match || !STANDALONE_INVITE_CODE.test(match[2] ?? "")) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:"
      && STANDALONE_INVITE_HOSTS.has(url.host)
      && url.username === ""
      && url.password === ""
      && url.pathname === "/t"
      && url.search === ""
      && STANDALONE_INVITE_CODE.test(url.hash.slice(1));
  } catch {
    return false;
  }
}

export const isStandaloneTranslateInvite = (value: StandaloneTranslateInvite): boolean =>
  isStandaloneTranslateInviteUrl(value.inviteUrl);

export const hasSafeStandaloneTranslateInvites = (value: StandaloneTranslateRoomCreated | StandaloneTranslateInviteResult): boolean =>
  "invite" in value
    ? isStandaloneTranslateInvite(value.invite)
    : isStandaloneTranslateInvite(value.host) && isStandaloneTranslateInvite(value.guest);

export const decodeExperienceTranslateRoomCreatedResponse = (value: unknown): ExperienceTranslateRoomCreatedResponse | null =>
  isExperienceTranslateRoomsSchema<ExperienceTranslateRoomCreatedResponse>("ExperienceProviderTranslateRoomCreated", value) ? value : null;
export const decodeExperienceTranslateRoomStatusResponse = (value: unknown): ExperienceTranslateRoomStatusResponse | null =>
  isExperienceTranslateRoomsSchema<ExperienceTranslateRoomStatusResponse>("ExperienceProviderTranslateRoomStatus", value) ? value : null;
export const decodeExperienceTranslateRoomEndResponse = (value: unknown): ExperienceTranslateRoomEndResponse | null =>
  isExperienceTranslateRoomsSchema<ExperienceTranslateRoomEndResponse>("TranslateRoomStateResult", value) ? value : null;
