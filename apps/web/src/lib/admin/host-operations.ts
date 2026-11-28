/*
 * 運営のホスト操作 (#711): what the Admin screen offers. The reason of a suspension is a machine code (the API takes any
 * `^[A-Z0-9_]{1,80}$`); the screen names these. Free text is never taken.
 */
export const HOST_SUSPENSION_REASONS = [
  { code: "POLICY_VIOLATION", label: "規約・掲載ルールに沿っていない" },
  { code: "SAFETY_CONCERN", label: "安全上の懸念" },
  { code: "UNDER_REVIEW", label: "内容を確認中" },
  { code: "OWNER_REQUEST", label: "本人からの依頼" },
] as const;

export const hostSuspensionReasonLabel = (code: string | null): string =>
  HOST_SUSPENSION_REASONS.find((reason) => reason.code === code)?.label ?? code ?? "";
