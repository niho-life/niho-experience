import type { components } from "../generated/fee-summary-openapi.ts";

type Schemas = components["schemas"];

export type ExperienceFeeSummary = Schemas["ExperienceFeeSummary"];
export type ExperienceFeeSummaryAccounting = Schemas["ExperienceFeeSummaryAccounting"];
export type ExperienceFeeSummaryPolicy = Schemas["ExperienceFeeSummaryPolicy"];
export type ExperienceFeeSummaryResponse = Schemas["ExperienceFeeSummaryResponse"];
export type ExperienceFeeSummaryStatus = ExperienceFeeSummary["status"];

