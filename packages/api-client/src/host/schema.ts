import { Ajv, type ValidateFunction } from "ajv";
import addFormatsModule from "ajv-formats";
import contractDocument from "../../contract/experience-host-api.openapi.json" with { type: "json" };
import { toJsonSchema } from "../public-schema-validation.ts";
import type { ExperienceProviderPageCreateRequest, ExperienceProviderPagePatchRequest, ExperienceProviderUploadPolicyRequest, ExperienceProviderUploadSignedUrlRequest } from "./types.ts";

type JsonObject = Record<string, unknown>;
const addFormats = addFormatsModule as unknown as (ajv: Ajv) => Ajv;
const schemas = ((contractDocument as unknown as JsonObject).components as JsonObject).schemas as JsonObject;
const ajv = new Ajv({ allErrors: true, strict: true, strictRequired: false });
addFormats(ajv);
const converted = JSON.parse(JSON.stringify(toJsonSchema(schemas)).replaceAll("contract#/$defs/", "experience-host#/$defs/")) as JsonObject;
ajv.addSchema({ $id: "experience-host", $defs: converted });
const compiled = new Map<string, ValidateFunction>();
function check<T>(name: string, value: unknown): value is T {
  let validate = compiled.get(name);
  if (!validate) { validate = ajv.compile({ $ref: `experience-host#/$defs/${name}` }); compiled.set(name, validate); }
  return validate(value) as boolean;
}
export const decodeExperienceProviderPageCreateRequest = (value: unknown): ExperienceProviderPageCreateRequest | null => check<ExperienceProviderPageCreateRequest>("AdminCampaignPageCreateRequest", value) ? value : null;
export const decodeExperienceProviderPagePatchRequest = (value: unknown): ExperienceProviderPagePatchRequest | null => check<ExperienceProviderPagePatchRequest>("ExperienceProviderPagePatchRequest", value) ? value : null;
export const decodeExperienceProviderUploadPolicyRequest = (value: unknown): ExperienceProviderUploadPolicyRequest | null => check<ExperienceProviderUploadPolicyRequest>("ExperienceProviderUploadPolicyRequest", value) ? value : null;
export const decodeExperienceProviderUploadSignedUrlRequest = (value: unknown): ExperienceProviderUploadSignedUrlRequest | null => check<ExperienceProviderUploadSignedUrlRequest>("UploadSignedUrlRequest", value) ? value : null;
