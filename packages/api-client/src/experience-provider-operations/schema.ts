import { Ajv, type ValidateFunction } from "ajv";
import addFormatsModule from "ajv-formats";
import contractDocument from "../../contract/experience-provider-operations-api.openapi.json" with { type: "json" };
import { toJsonSchema } from "../public-schema-validation.ts";
import type {
  ExperienceProviderCancelBookingInput,
  ExperienceProviderMessageInput,
  ExperienceProviderPutMemberInput,
  ExperienceProviderResolveMemberInput,
} from "./types.ts";

type JsonObject = Record<string, unknown>;
const addFormats = addFormatsModule as unknown as (ajv: Ajv) => Ajv;
const document = contractDocument as unknown as JsonObject;
const schemas = (document.components as JsonObject).schemas as JsonObject;
const ajv = new Ajv({ allErrors: true, strict: true, strictRequired: false });
addFormats(ajv);
const converted = JSON.parse(JSON.stringify(toJsonSchema(schemas)).replaceAll("contract#/$defs/", "experience-provider-operations#/$defs/")) as JsonObject;
ajv.addSchema({ $id: "experience-provider-operations", $defs: converted });
const compiled = new Map<string, ValidateFunction>();

function validator(name: string): ValidateFunction {
  const cached = compiled.get(name);
  if (cached) return cached;
  if (!(name in schemas)) throw new Error(`unknown experience provider operations schema: ${name}`);
  const value = ajv.compile({ $ref: `experience-provider-operations#/$defs/${name}` });
  compiled.set(name, value);
  return value;
}

export function isExperienceProviderOperationsSchema<T>(name: string, value: unknown): value is T {
  return validator(name)(value) as boolean;
}

export const isExperienceProviderOperationPathId = (value: unknown): value is string =>
  typeof value === "string" && value.length >= 1 && value.length <= 200 && value !== "." && value !== ".." && !/[/\\%\u0000-\u001f\u007f]/.test(value);

export const isExperienceProviderBookingCursor = (value: unknown): value is string =>
  typeof value === "string" && value.length >= 1 && value.length <= 2048 && !/[\u0000-\u001f\u007f]/.test(value);

export const decodeExperienceProviderResolveMemberInput = (value: unknown): ExperienceProviderResolveMemberInput | null =>
  isExperienceProviderOperationsSchema<ExperienceProviderResolveMemberInput>("ResolveMemberInput", value) ? value : null;
export const decodeExperienceProviderPutMemberInput = (value: unknown): ExperienceProviderPutMemberInput | null =>
  isExperienceProviderOperationsSchema<ExperienceProviderPutMemberInput>("PutMemberInput", value) ? value : null;
export const decodeExperienceProviderCancelBookingInput = (value: unknown): ExperienceProviderCancelBookingInput | null =>
  isExperienceProviderOperationsSchema<ExperienceProviderCancelBookingInput>("CancelBookingInput", value) ? value : null;
export const decodeExperienceProviderMessageInput = (value: unknown): ExperienceProviderMessageInput | null =>
  isExperienceProviderOperationsSchema<ExperienceProviderMessageInput>("MessageInput", value) ? value : null;
