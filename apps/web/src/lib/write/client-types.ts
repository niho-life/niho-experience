export type WriteGuideStatus = "DRAFT" | "PUBLISHED" | "STOPPED" | "OPS_STOPPED";
export type WriteVisibility = "PUBLIC" | "UNLISTED";

export type WriteAuthor = { readonly name: string; readonly role: string; readonly bio: string };
export type WriteCover = { readonly assetId: string; readonly alt: string; readonly credit: string; readonly webConfirmed: boolean };
export type WriteProductLink = { readonly providerId: string; readonly productId: string };

export type WriteGuide = {
  readonly id: string;
  readonly slug: string;
  readonly subject: { readonly kind: "PROVIDER"; readonly providerId: string };
  readonly title: string;
  readonly description: string;
  readonly categorySlug?: string;
  readonly content: { readonly markdown: string; readonly language?: "en"; readonly author?: WriteAuthor; readonly checkedOn?: string };
  readonly cover?: WriteCover;
  readonly draftProductLinks: readonly WriteProductLink[];
  readonly status: WriteGuideStatus;
  readonly opsStopReason?: string;
  readonly opsStopContact?: string;
  readonly revision: number;
  readonly currentPublication?: {
    readonly id: number;
    readonly number: number;
    readonly sourceRevision: number;
    readonly visibility: WriteVisibility;
    readonly publishedAtUtc: string;
  };
  readonly createdAtUtc: string;
  readonly updatedAtUtc: string;
};

export type WriteDraft = {
  readonly slug: string;
  readonly title: string;
  readonly description: string;
  readonly categorySlug?: string;
  readonly content: { readonly markdown: string; readonly language: "en"; readonly author?: WriteAuthor; readonly checkedOn?: string };
  readonly cover: WriteCover | null;
  readonly draftProductLinks: readonly WriteProductLink[];
};

export type WriteCategory = { readonly slug: string; readonly labelEn: string; readonly labelJa: string; readonly displayOrder: number };
export type WriteProductChoice = { readonly id: string; readonly providerId: string; readonly slug: string; readonly title: string };
export type WriteMediaAsset = { readonly id: string; readonly width: number; readonly height: number; readonly publicCredit?: string; readonly webConfirmed: boolean; readonly previewUrl?: string };
export type WriteProviderChoice = { readonly id: string; readonly displayName: string };

export function hasSavedChangesSincePublication(guide: Pick<WriteGuide, "revision" | "currentPublication">): boolean {
  return guide.currentPublication !== undefined && guide.revision > guide.currentPublication.sourceRevision + 1;
}

export function writeStatusLabel(guide: Pick<WriteGuide, "status" | "currentPublication" | "revision">): string {
  if (guide.status === "OPS_STOPPED") return "運営により停止";
  if (guide.status === "STOPPED") return "公開停止中";
  if (guide.status === "DRAFT") return "下書き";
  const visibility = guide.currentPublication?.visibility === "UNLISTED" ? "限定公開" : "公開中";
  return hasSavedChangesSincePublication(guide) ? `${visibility}・未公開の変更あり` : visibility;
}
