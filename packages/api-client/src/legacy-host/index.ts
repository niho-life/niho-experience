// ホスト API（体験の提供者の本人向け API）の型とクライアント。**サーバー専用**：ID token を Authorization に載せるので、
// ブラウザのコードから import しない（ブラウザはこのサイトの `/host/api/*` の中継を呼ぶ）。型だけの import はどこからでもよい。
export * from "./types.ts";
export { EXPERIENCE_LEGACY_HOST_API_CONTRACT as EXPERIENCE_HOST_API_CONTRACT } from "../contract-meta.ts";
export {
  createExperienceHostApiClient,
  isStripeConnectUrl,
  toExperienceProviderPhotoUploadForm,
  type ExperienceHostApiClient,
  type ExperienceHostApiClientOptions,
  type ExperienceHostApiError,
  type ExperienceHostApiErrorCode,
  type ExperienceHostApiErrorReason,
  type ExperienceHostApiFailure,
  type ExperienceHostApiResult,
} from "./client.ts";
export type { FetchLike } from "../client.ts";
