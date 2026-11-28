import { HOST_ACCOUNT_PATH, withQuery } from "./routes";

/*
 * 選んでいるホストを、ホスト画面の API に渡す (#709, Epic #700 §4「1 人で複数のホスト」)。
 *
 * 1 人が 2 つ以上のホストのオーナーになると、サーバーは `?providerId=` が無い呼び出しを 409 PROVIDER_REQUIRED で断る
 * (段階0 resolveProviderContext)。画面の client は、いま開いているホストの id を、ホスト単位の API のすべてに付ける。
 * 付け方はここの 1 か所だけで、呼び出し元は文字列をつながない。id は hint で、サーバーが毎回 membership と照合する。
 */

/**
 * `path` に `providerId` を付ける。`path` がもつ query はそのまま残し、providerId が無い (null / undefined / 空) ときは何も足さない。
 * 管理画面 (`/admin/api/...`) の呼び出しには providerId を渡さない。
 */
export function hostApiPath(path: string, providerId: string | null | undefined): string {
  return withQuery(path, { providerId });
}

/** The code the host APIs answer when an account owns two or more hosts and the call names none (409). */
export const PROVIDER_REQUIRED_CODE = "PROVIDER_REQUIRED";

/** 409 PROVIDER_REQUIRED を、汎用のエラーにせず言葉にする。切り替えの場所は「あなたのアカウント」の所属一覧。 */
export const PROVIDER_REQUIRED_MESSAGE = "ホストを選んでください。";
export const PROVIDER_SWITCH_PATH = `${HOST_ACCOUNT_PATH}#account-providers`;
export const PROVIDER_SWITCH_LABEL = "ホストを選ぶ";

/** The error code of a host API's JSON body (`{ error: { code } }`), or "". */
export function apiErrorCode(body: unknown): string {
  const error = typeof body === "object" && body !== null && "error" in body ? (body as { error?: unknown }).error : null;
  return typeof error === "object" && error !== null && "code" in error ? String((error as { code: unknown }).code) : "";
}

/** True for the 409 that asks the caller to say which host (the status is part of the contract: 409 alone is something else). */
export function isProviderRequired(status: number, body: unknown): boolean {
  return status === 409 && apiErrorCode(body) === PROVIDER_REQUIRED_CODE;
}

/**
 * The host a console screen sends to the host APIs: the one it shows. Null when the address names a host the account does not
 * have (the screen then says 「ホストを選んでください」 instead of acting for another host) or when the account has none.
 */
export function screenProviderId(context: { readonly provider: { readonly id: string } | null; readonly providerNotFound: boolean }): string | null {
  return context.providerNotFound ? null : context.provider?.id ?? null;
}
