import { Ajv, type ValidateFunction } from "ajv";
import addFormatsModule from "ajv-formats";
import contractDocument from "../../contract/experience-preparations-api.openapi.json" with { type: "json" };
import { toJsonSchema } from "../public-schema-validation.ts";
import type {
  ExperiencePreparationAcceptanceInput,
  ExperiencePreparationDraft,
  ExperiencePreparationCohostPatchInput,
  ExperiencePreparationLockedAcceptanceInput,
  ExperiencePreparationUploadPolicyInput,
} from "./types.ts";

type JsonObject = Record<string, unknown>;
const addFormats = addFormatsModule as unknown as (ajv: Ajv) => Ajv;
const document = contractDocument as unknown as JsonObject;
const components = document.components as JsonObject;
const schemas = components.schemas as JsonObject;
const ajv = new Ajv({ allErrors: true, strict: true, strictRequired: false });
addFormats(ajv);
const convertedSchemas = JSON.parse(JSON.stringify(toJsonSchema(schemas)).replaceAll("contract#/$defs/", "experience-preparations#/$defs/")) as JsonObject;
ajv.addSchema({ $id: "experience-preparations", $defs: convertedSchemas });
const compiled = new Map<string, ValidateFunction>();

function validator(schemaName: string): ValidateFunction {
  const cached = compiled.get(schemaName);
  if (cached) return cached;
  if (!(schemaName in schemas)) throw new Error(`unknown experience preparation schema: ${schemaName}`);
  const value = ajv.compile({ $ref: `experience-preparations#/$defs/${schemaName}` });
  compiled.set(schemaName, value);
  return value;
}

export function isExperiencePreparationSchema<T>(schemaName: string, value: unknown): value is T {
  return validator(schemaName)(value) as boolean;
}

export const isExperiencePreparationPathId = (value: unknown): value is string =>
  typeof value === "string" && value.length >= 1 && value.length <= 128 && value !== "." && value !== ".." && !/[/\\%\u0000-\u001f\u007f]/.test(value);

export const isExperiencePreparationSearch = (value: unknown): value is string =>
  typeof value === "string" && Array.from(value.trim()).length >= 2 && Array.from(value.trim()).length <= 100;

export const isExperiencePreparationCorrection = (value: unknown): value is string =>
  typeof value === "string" && Array.from(value.trim()).length >= 1 && Array.from(value.trim()).length <= 2_000 && !value.includes("\0");

export const decodeExperiencePreparationDraft = (value: unknown): ExperiencePreparationDraft | null =>
  isExperiencePreparationSchema<ExperiencePreparationDraft>("Draft", value) ? value : null;

export const decodeExperiencePreparationCohostPatch = (value: unknown): ExperiencePreparationCohostPatchInput | null =>
  isExperiencePreparationSchema<ExperiencePreparationCohostPatchInput>("CohostPatchInput", value) ? value : null;

export const decodeExperiencePreparationAcceptance = (value: unknown): ExperiencePreparationAcceptanceInput | null =>
  isExperiencePreparationSchema<ExperiencePreparationAcceptanceInput>("AcceptanceInput", value) ? value : null;

export const decodeExperiencePreparationLockedAcceptance = (value: unknown): ExperiencePreparationLockedAcceptanceInput | null =>
  isExperiencePreparationSchema<ExperiencePreparationLockedAcceptanceInput>("LockedAcceptanceInput", value) ? value : null;

export const decodeExperiencePreparationUploadPolicyInput = (value: unknown): ExperiencePreparationUploadPolicyInput | null =>
  isExperiencePreparationSchema<ExperiencePreparationUploadPolicyInput>("UploadPolicyInput", value) ? value : null;

export function decodeExperiencePreparationErrorReason(value: unknown): string | null {
  if (!isExperiencePreparationSchema<Record<string, unknown>>("ErrorResponse", value)) return null;
  const error = value.error as Record<string, unknown>;
  const details = error.details as Record<string, unknown>;
  const selected = ["PREPARATION_REVISION_CONFLICT", "PREPARATION_ACCEPTANCE_STALE", "PREPARATION_PROVIDER_OWNER_REQUIRED", "PREPARATION_STATE_CONFLICT"];
  return typeof details.reason === "string" && selected.includes(details.reason) ? details.reason : null;
}
