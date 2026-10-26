/**
 * 契約の版と状態（contract/experience-public-api.openapi.json の info と一致することを test が確かめる）。
 * `agreed` は NIHO 側（niho-app の contracts/exports）が書き出した配布物であることを表す。実 API と接続済みかどうかは
 * 配備と `verify:live` の結果で判断し、画面・文書で接続済みと表示しない。
 */
export const EXPERIENCE_API_CONTRACT = {
  version: "1.2.0",
  status: "agreed",
} as const;

/**
 * ホスト API の契約（contract/experience-host-api.openapi.json）の版と状態。`draft` は NIHO 側（niho-app の contracts/exports）が
 * 書き出したが、まだ NIHO の main に入っていない・配備されていない段階を表す。ホストの画面は mock で作り、実 API と接続済みとは扱わない。
 */
export const EXPERIENCE_HOST_API_CONTRACT = {
  version: "0.2.0",
  status: "draft",
} as const;

/**
 * Admin 認証だけの選別済み契約。NIHO 側 b1bee0090e の先行実装に対応するが、
 * まだ配備済みとは扱わない。予約・料金・通知・ホスト設定 API は含まない。
 */
export const EXPERIENCE_ADMIN_AUTH_API_CONTRACT = {
  version: "1.0.0",
  status: "agreed",
  sourceCommit: "b1bee0090e",
  deploymentStatus: "not-deployed",
} as const;

/** Selected Admin booking/notification read contract. Agreed, but not deployed by NIHO yet. */
export const EXPERIENCE_ADMIN_READ_API_CONTRACT = {
  version: "1.0.0",
  sourceCommit: "08736836328976b130b919bef0ebcdad7d5ba7bb",
  status: "agreed-not-deployed",
  deploymentStatus: "not-deployed",
} as const;

/** Selected Admin per-booking assignee/internal-memo contract. Agreed, but not deployed by NIHO yet. */
export const EXPERIENCE_ADMIN_SUPPORT_CASE_API_CONTRACT = {
  version: "1.0.0",
  sourceCommit: "9ddb79c3a62bafca6896a06fa2f364f1fb089ff3",
  status: "agreed-not-deployed",
  deploymentStatus: "not-deployed",
} as const;

/** Selected immutable Admin booking operations contract. Agreed, but not deployed by NIHO yet. */
export const EXPERIENCE_ADMIN_OPERATIONS_API_CONTRACT = {
  version: "1.0.0",
  sourceCommit: "d3e403a140ce39a890f22976c81b5b00ffbea8e2",
  status: "agreed-not-deployed",
  deploymentStatus: "not-deployed",
} as const;

/** Selected host-owned support history contract. Agreed, but not deployed by NIHO yet. */
export const EXPERIENCE_HOST_SUPPORT_HISTORY_API_CONTRACT = {
  version: "1.0.0",
  sourceCommit: "d3e403a140ce39a890f22976c81b5b00ffbea8e2",
  status: "agreed-not-deployed",
  deploymentStatus: "not-deployed",
} as const;

/** Host本人のNIHOサポート設定契約。API先行配備と受入が終わるまでは既定OFFで接続しない。 */
export const EXPERIENCE_HOST_SUPPORT_SETTINGS_API_CONTRACT = {
  version: "1.0.1",
  sourceCommit: "4787c3b34b2c30d51a9f0f523c34f865c20e4230",
  sha256: "9cff926462fe388b8ff5a8c82a582eb26d6aafc8eba49f5468ea064021c07a75",
  status: "agreed-not-deployed",
  deploymentStatus: "not-deployed",
} as const;

/** Adminとホスト本人が予約別の実料金・精算状況を読む契約。API先行配備と受入までは既定OFFで接続しない。 */
export const EXPERIENCE_FEE_SUMMARY_API_CONTRACT = {
  version: "1.0.0",
  sourceCommit: "291bc1fca9a9e21ebaeae4a9637379afc472aa61",
  sha256: "c7b39ac5ae5331268915f4b9b2ded477a09f35eb333a291a9826e6b8f3a9d95e",
  status: "agreed-not-deployed",
  deploymentStatus: "not-deployed",
} as const;

/** 事務局と店舗本人の伴走立ち上げ契約。認証依存とAPIの配備・受入まではHTTPを開かない。 */
export const EXPERIENCE_PREPARATIONS_API_CONTRACT = {
  version: "3.0.0",
  sourceCommit: "3c742592574e8d61377cb89a817b24b76917ff56",
  sha256: "44aa492ede6bb40baddb7295c32f8828028177852f764d0369c0b9d6dfaa443c",
  status: "agreed-not-deployed",
  deploymentStatus: "not-deployed",
} as const;

/** 提供者チームと日常の予約運営だけを選別した契約。配備・受入まではHTTPを既定OFFにする。 */
export const EXPERIENCE_PROVIDER_OPERATIONS_API_CONTRACT = {
  version: "1.1.0",
  sourceCommit: "e0f3bf8226f777eef421d534163b92ff9e5394f1",
  sha256: "c5ffd259b811635eee0bcef7fa177ae96c02cafe0b752071364526b86416e749",
  status: "agreed-not-deployed",
  deploymentStatus: "not-deployed",
} as const;

/** 予約に関わる時刻の基準。表示も日本時間（Asia/Tokyo）で行う。 */
export const EXPERIENCE_TIME_ZONE = "Asia/Tokyo";

/** 開催回を返す期間（日本時間の今日から）。 */
export const EXPERIENCE_AVAILABILITY_WINDOW_DAYS = 90;

/** ゲスト入力の上限（契約の ExperienceCheckoutRequest と同じ）。 */
export const EXPERIENCE_CHECKOUT_INPUT_LIMITS = {
  guestNameMaxLength: 100,
  guestEmailMaxLength: 254,
  noteMaxLength: 500,
  shortTextAnswerMaxLength: 200,
  longTextAnswerMaxLength: 1000,
  clientRequestKeyMinLength: 8,
  clientRequestKeyMaxLength: 120,
} as const;
