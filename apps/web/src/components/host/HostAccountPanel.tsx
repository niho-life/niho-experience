import { config } from "@/lib/config";
import { HOST_LOGOUT_PATH } from "@/lib/host/routes";
import type { NihoAccountRowData } from "@/lib/host/niho-account-row-server";
import type { HostSession } from "@/lib/host/session";
import { FieldRow, FieldSection } from "./fields";
import { consoleButtonClass } from "./host-ui";
import { HostIcon } from "./HostIcon";
import { HostNihoAccountRow } from "./HostNihoAccountRow";
import { AccountAvatar } from "./ui";

/**
 * ログイン: the NIHO account (or, with Experience host accounts, the address the host signs in with, and with the NIHO
 * account login the NIHO account it is bound to, Epic #591) and ログアウト (its form cannot sit inside a settings form).
 */
export function AccountPanel({ session, niho = null }: { session: Pick<HostSession, "kind" | "displayName" | "iconUrl">; niho?: NihoAccountRowData | null }) {
  const account = { displayName: session.displayName, iconUrl: session.iconUrl };
  const experience = session.kind === "experience";
  return (
    <FieldSection id="settings-account" title="ログイン">
      <FieldRow label={experience ? "ログインのメール" : "NIHO アカウント"} labelId="settings-account-label">
        <div role="group" aria-labelledby="settings-account-label" className="flex min-h-10 flex-wrap items-center gap-2.5">
          <AccountAvatar account={account} className="size-6 text-[0.75rem]" />
          <span className="[overflow-wrap:anywhere]">{account.displayName || (experience ? "" : "NIHO アカウント")}</span>
          {experience ? null : (
            <a href={config.nihoWebOrigin} className={consoleButtonClass("secondary", "sm")}>
              <HostIcon name="external" className="size-3.5" />
              NIHO アプリ
            </a>
          )}
        </div>
      </FieldRow>
      {niho ? <HostNihoAccountRow providerId={niho.providerId} status={niho.status} outcome={niho.outcome} /> : null}
      <div className="border-t border-line pt-3 md:pl-[184px]">
        <form method="post" action={HOST_LOGOUT_PATH} data-niho-navigation-form>
          <button type="submit" className={consoleButtonClass("ghost", "sm")}>
            ログアウト
          </button>
        </form>
      </div>
    </FieldSection>
  );
}
