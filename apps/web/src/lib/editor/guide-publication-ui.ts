import type { GuideArticleStatus, GuidePublicationVisibility } from "@niho-experience/experience-store";

export function guidePublicationStatusLabel(
  status: GuideArticleStatus,
  visibility?: GuidePublicationVisibility,
): string {
  if (status === "PUBLISHED") return visibility === "UNLISTED" ? "非掲載の公開版あり" : "公開版あり";
  if (status === "STOPPED") return "公開停止中";
  return "未公開";
}

export function guidePublicationActionLabel(status: GuideArticleStatus, busy: boolean): string {
  if (busy) return status === "PUBLISHED" ? "更新中" : "保存中";
  return status === "PUBLISHED" ? "公開版を更新" : "公開版を保存";
}

export function guidePublicationNeedsSave(dirty: boolean, revision: number | null): boolean {
  return dirty || revision === null;
}
