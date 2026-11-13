import type { NihoIdentityStatus } from "@niho-experience/experience-store";
import { HOST_NIHO_IDENTITY_PATH } from "@/lib/host/routes";
import { NIHO_IDENTITY_OUTCOMES, type NihoIdentityOutcome } from "@/lib/host/niho-identity";
import { FieldRow } from "./fields";
import { consoleButtonClass } from "./host-ui";

/** `null`: nothing is bound; `"error"`: the store could not say. The NIHO user ID is never part of it. */
export type NihoAccountRowStatus = NihoIdentityStatus | null | "error";

const day = (utc: string) => new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", year: "numeric", month: "numeric", day: "numeric" }).format(new Date(utc));

function Hidden({ action, providerId }: { action: "link" | "unlink"; providerId: string | null }) {
  return (
    <>
      <input type="hidden" name="action" value={action} />
      {providerId ? <input type="hidden" name="providerId" value={providerId} /> : null}
    </>
  );
}

/**
 * 設定 › ログイン情報: the NIHO account the host account is bound to (Epic #591, #595). Both buttons are plain forms (no
 * JavaScript): 「結び付ける」 goes to NIHO and back, 「解除」 asks first. A binding needs a recent sign-in, so the answer to a
 * stale one is a sign-in again and back here; `outcome` tells what the last attempt did. Nothing here names the NIHO account.
 */
export function HostNihoAccountRow({ providerId, status, outcome }: { providerId: string | null; status: NihoAccountRowStatus; outcome: NihoIdentityOutcome | null }) {
  const notice = outcome ? NIHO_IDENTITY_OUTCOMES[outcome] : null;
  return (
    <FieldRow label="NIHO アカウント" labelId="settings-niho-label">
      <div role="group" aria-labelledby="settings-niho-label" className="grid gap-2.5 py-1">
        {notice ? (
          <p role={notice.tone === "problem" ? "alert" : "status"} className={`rounded-xl p-3 ${notice.tone === "problem" ? "bg-warn-pale text-warn" : "bg-info-pale text-ink"}`}>{notice.text}</p>
        ) : null}
        {status === "error" ? (
          <p role="alert" className="text-danger">結び付けの状態を確認できません。時間をおいて、ページを読み込み直してください。</p>
        ) : status === null ? (
          <>
            <p className="text-ink">結び付けていません</p>
            <p className="text-[0.875rem] text-ink-soft">結び付けると、「NIHO アカウントでログイン」でこのホストアカウントに入れます。結び付けるには、30 分以内のログインが必要です。</p>
            <form method="post" action={HOST_NIHO_IDENTITY_PATH} data-niho-navigation-form>
              <Hidden action="link" providerId={providerId} />
              <button type="submit" className={consoleButtonClass("secondary", "sm")}>NIHO アカウントを結び付ける</button>
            </form>
          </>
        ) : (
          <>
            <p className="text-ink">結び付け済み</p>
            <p className="text-[0.875rem] text-ink-soft">
              結び付けた日：{day(status.linkedAtUtc)}
              {status.lastLoginAtUtc ? `　最後のログイン：${day(status.lastLoginAtUtc)}` : ""}
            </p>
            <details className="text-[0.875rem]">
              <summary className="cursor-pointer font-bold text-ink-soft underline underline-offset-4 hover:text-ink">結び付けを解除する</summary>
              <form method="post" action={HOST_NIHO_IDENTITY_PATH} data-niho-navigation-form className="mt-2.5 grid gap-2.5">
                <Hidden action="unlink" providerId={providerId} />
                <p className="text-ink-soft">解除すると、この NIHO アカウントではホストにログインできなくなります。いまのログインはそのまま続きます。解除には、30 分以内のログインが必要です。</p>
                <div><button type="submit" className={consoleButtonClass("secondary", "sm")}>解除する</button></div>
              </form>
            </details>
          </>
        )}
      </div>
    </FieldRow>
  );
}
