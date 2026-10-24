// 合成データと pilot fixture の mock（プレビュー・テスト専用）。本番の画面からは読み込まない。
export {
  createMockExperienceFetch,
  isMockCheckoutUrl,
  MOCK_CATALOGS,
  MOCK_SCENARIOS,
  type MockCatalog,
  type MockExperienceFetchOptions,
  type MockScenario,
} from "./mock-fetch.ts";
export { placeholderImage, placeholderSvg } from "./placeholder-image.ts";
export { buildFixtureExperiences, FIXTURE_CONSENT_VERSION, FIXTURE_IMAGE_SPECS } from "../fixtures/experiences.ts";
export { buildPilotExperiences, PILOT_CONTENT_STATUS, PILOT_HOST_PHOTOS, PILOT_IMAGE_SPECS, PILOT_SAMPLE_PHOTO_PATH } from "../fixtures/pilot-experiences.ts";
export { buildMockOccurrences } from "../fixtures/availability.ts";
export { journeyExtrasFor, reviewsResponseFor } from "../fixtures/journey.ts";
export { toExperienceSummary } from "../fixtures/catalog.ts";
