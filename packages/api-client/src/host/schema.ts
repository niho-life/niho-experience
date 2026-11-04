import { Ajv, type ValidateFunction } from "ajv";
import addFormatsModule from "ajv-formats";
import contractDocument from "../../contract/experience-host-api.openapi.json" with { type: "json" };
import { toJsonSchema } from "../public-schema-validation.ts";

type JsonObject = Record<string, unknown>;
const addFormats = addFormatsModule as unknown as (ajv: Ajv) => Ajv;
const schemas = ((contractDocument as unknown as JsonObject).components as JsonObject).schemas as JsonObject;
const ajv = new Ajv({ allErrors: true, strict: true, strictRequired: false });
addFormats(ajv);
const converted = JSON.parse(JSON.stringify(toJsonSchema(schemas)).replaceAll("contract#/$defs/", "experience-host#/$defs/")) as JsonObject;
ajv.addSchema({ $id: "experience-host", $defs: converted });
const compiled = new Map<string, ValidateFunction>();

/** Validate only schemas present in the pinned NIHO host common contract. */
export function isExperienceHostApiSchema<T>(name: string, value: unknown): value is T {
  let validate = compiled.get(name);
  if (!validate) {
    if (!Object.hasOwn(schemas, name)) return false;
    try {
      validate = ajv.compile({ $ref: `experience-host#/$defs/${name}` });
    } catch { return false; }
    compiled.set(name, validate);
  }
  return validate(value) as boolean;
}
