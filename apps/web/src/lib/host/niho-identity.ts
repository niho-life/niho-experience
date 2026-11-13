/**
 * NIHO アカウントの結び付け (Epic #591, #595): what 設定 › ログイン情報 tells after a link or an unlink (`?niho=`). Shared by the
 * routes that set it and the page that shows it; no account, NIHO user ID or token is ever part of a value.
 */
export const NIHO_IDENTITY_OUTCOMES = {
  linked: { tone: "ok", text: "NIHO アカウントを結び付けました。次からは「NIHO アカウントでログイン」で入れます。" },
  "already-linked": { tone: "ok", text: "この NIHO アカウントは、すでに結び付いています。" },
  unlinked: { tone: "ok", text: "結び付けを解除しました。" },
  "not-linked": { tone: "ok", text: "結び付いている NIHO アカウントはありません。" },
  "identity-in-use": { tone: "problem", text: "この NIHO アカウントは、すでに別のホストアカウントに結び付いているため、結び付けられません。ログインした NIHO アカウントを確かめてください。" },
  "account-has-identity": { tone: "problem", text: "このホストアカウントには、すでに別の NIHO アカウントが結び付いています。先に解除してから、結び付けてください。" },
  "last-method": { tone: "problem", text: "ほかにログインできる方法が無くなるため、解除できません。" },
  reauth: { tone: "problem", text: "ログインから時間がたっています。もう一度ログインしてから、やり直してください。" },
  denied: { tone: "problem", text: "NIHO でログインが取り消されました。結び付けるには、もう一度お試しください。" },
  unavailable: { tone: "problem", text: "NIHO アカウントを結び付けられませんでした。時間をおいて、もう一度お試しください。" },
} as const;

export type NihoIdentityOutcome = keyof typeof NIHO_IDENTITY_OUTCOMES;

export function nihoIdentityOutcomeOrNull(value: unknown): NihoIdentityOutcome | null {
  return typeof value === "string" && Object.hasOwn(NIHO_IDENTITY_OUTCOMES, value) ? value as NihoIdentityOutcome : null;
}

/**
 * Whether the host can still sign in another way once the NIHO account is unbound: the emailed link, whose routes stay as
 * the migration fallback. #598 decides whether it is removed; the answer changes there, and an unlink is refused while
 * it is false (HostAccountIdentities.unlinkNihoIdentity).
 */
export const EMAIL_SIGN_IN_AVAILABLE = true;
