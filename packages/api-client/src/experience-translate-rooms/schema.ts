import { Ajv, type ValidateFunction } from "ajv";
import addFormatsModule from "ajv-formats";
import contractDocument from "../../contract/experience-translate-rooms-api.openapi.json" with { type: "json" };
import { toJsonSchema } from "../public-schema-validation.ts";
import type { ExperienceTranslateRoomCreatedResponse, ExperienceTranslateRoomEndResponse, ExperienceTranslateRoomStatusResponse } from "./types.ts";

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

export const decodeExperienceTranslateRoomCreatedResponse = (value: unknown): ExperienceTranslateRoomCreatedResponse | null =>
  isExperienceTranslateRoomsSchema<ExperienceTranslateRoomCreatedResponse>("TranslateRoomCreatedResponse", value) ? value : null;
export const decodeExperienceTranslateRoomStatusResponse = (value: unknown): ExperienceTranslateRoomStatusResponse | null =>
  isExperienceTranslateRoomsSchema<ExperienceTranslateRoomStatusResponse>("TranslateRoomStatusResponse", value) ? value : null;
export const decodeExperienceTranslateRoomEndResponse = (value: unknown): ExperienceTranslateRoomEndResponse | null =>
  isExperienceTranslateRoomsSchema<ExperienceTranslateRoomEndResponse>("TranslateRoomEndResponse", value) ? value : null;
