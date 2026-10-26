import type { ExperiencePreparationReadiness } from "@niho-experience/api-client/experience-preparations";

export const PREPARATION_STATUS_LABELS = { DRAFT: "下書き", REVIEW: "店舗確認中", ACCEPTED: "本人受入済み", REPRESENTATIVE_VERIFIED: "代表者確認済み", MATERIALIZED: "正式反映済み", CANCELLED: "終了" } as const;

export const READINESS_LABELS = {
  representativeAcceptance: { WAITING: "店舗の受入待ち", ACCEPTED: "受入済み", STALE: "更新内容の再確認が必要" },
  representativeVerification: { WAITING: "事務局の確認待ち", VERIFIED: "確認済み", STALE: "更新後の再確認が必要" },
  payment: { NOT_CONNECTED: "売上受取の設定が必要", VERIFICATION_REQUIRED: "追加の本人確認が必要", CHARGES_DISABLED: "支払い受付を確認中", PAYOUTS_DISABLED: "売上受取を確認中", RESTRICTED: "設定内容の確認が必要", READY: "設定済み", NOT_MATERIALIZED: "店舗の正式登録後に確認" },
  providerReview: { DRAFT: "本人確認の準備中", REQUESTED: "本人確認の審査中", APPROVED: "確認済み", SUSPENDED: "事務局への確認が必要", NOT_MATERIALIZED: "店舗の正式登録後に確認", UNKNOWN: "状態を確認中" },
  products: { NOT_MATERIALIZED: "商品の正式登録前", DRAFT_READY: "非公開商品を準備済み", DRAFT_INCOMPLETE: "商品情報の追加が必要", APPROVED_SNAPSHOT_CHANGED: "更新内容の再審査が必要" },
  listing: { NOT_REQUESTED: "掲載審査の申請前", REQUESTED: "掲載審査中", ACTIVE: "掲載中", PAUSED: "掲載を一時停止中", WITHDRAWN: "掲載を終了", NOT_MATERIALIZED: "商品の正式登録前", UNKNOWN: "状態を確認中" },
} as const satisfies {
  [K in "representativeAcceptance" | "representativeVerification" | "payment" | "providerReview" | "products" | "listing"]: Record<ExperiencePreparationReadiness[K], string>
};

export function readinessBlockerLabel(value: string): string {
  return /^[A-Z][A-Z0-9_]*$/.test(value) ? "販売開始に必要な手続きが残っています。" : value;
}
