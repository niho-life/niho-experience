import { fullDateJa } from "@/host/format";
import type { HostNotice } from "@/host/payout";
import {
  experiencePayoutLines,
  experiencePayoutStatus,
  PAYOUT_ACCOUNT_TEXT,
  payoutAccountConsentText,
  type ExperiencePayoutLoad,
} from "@/host/payout-account";
import { HOST_PAYOUT_CONSENT_PATH, HOST_SETTINGS_PAYOUT_ANCHOR } from "@/lib/host/routes";
import { FieldRow, FieldSection } from "./fields";
import { consoleButtonClass } from "./host-ui";
import { HostNoticeLine } from "./HostNoticeLine";

/** "2026年11月7日" in Japan. */
const japanDate = (at: string) => fullDateJa(new Date(Date.parse(at) + 9 * 3_600_000).toISOString().slice(0, 10));

/**
 * 設定 › 受取口座 with Experience host accounts (ADR 0003 slice 3, docs/host-accounts.md): the account Admin/ops registered
 * (its last 4 characters only), what Stripe says of it in plain words, and the OWNER's consent to receive the provider's
 * Experience sales in it, given with the versioned text and an explicit checkbox, or withdrawn. Plain forms (no
 * JavaScript): they post to the consent route, which asks for a sign-in within 30 minutes first and comes back here.
 */
export function HostPayoutAccountPanel({ providerId, load, notice }: { providerId: string; load: ExperiencePayoutLoad; notice: HostNotice | null }) {
  const status = experiencePayoutStatus(load);
  return (
    <FieldSection id={HOST_SETTINGS_PAYOUT_ANCHOR} title="受取口座" status={status}>
      {load.status === "not-owner" ? <p className="flex min-h-10 items-center text-ink-soft">{PAYOUT_ACCOUNT_TEXT.ownerOnly}</p>
        : load.status === "error" ? <p role="alert" className="flex min-h-10 items-center text-danger">{PAYOUT_ACCOUNT_TEXT.unreadable}</p>
        : load.status === "setup-required" ? <p className="flex min-h-10 items-center text-ink-soft">{PAYOUT_ACCOUNT_TEXT.setupRequired}</p>
        : <OwnerPayout providerId={providerId} load={load} />}
      <HostNoticeLine notice={notice} className="pt-1" />
    </FieldSection>
  );
}

function OwnerPayout({ providerId, load }: { providerId: string; load: Extract<ExperiencePayoutLoad, { status: "owner" }> }) {
  const lines = experiencePayoutLines(load);
  const consentText = payoutAccountConsentText({ providerName: load.providerName, accountLast4: load.accountLast4 });
  const formFields = (action: "consent" | "withdraw") => (
    <>
      <input type="hidden" name="providerId" value={providerId} />
      <input type="hidden" name="action" value={action} />
      <input type="hidden" name="accountLast4" value={load.accountLast4} />
      {action === "consent" ? <input type="hidden" name="consentVersion" value={load.consentVersion} /> : null}
    </>
  );
  return (
    <>
      <FieldRow label="口座" labelId="settings-payout-account">
        <p className="flex min-h-10 items-center">Stripe の口座（末尾 {load.accountLast4}）</p>
      </FieldRow>
      <FieldRow label="Stripe の状態" labelId="settings-payout-stripe">
        <ul aria-labelledby="settings-payout-stripe" className={`grid gap-1 py-2 ${load.stripe === "ready" ? "text-ink-soft" : "text-warn"}`}>
          {lines.map((line) => <li key={line}>{line}</li>)}
        </ul>
      </FieldRow>
      <FieldRow label="売上の受け取り" labelId="settings-payout-consent">
        {load.consent.state === "unknown" ? <p className="py-2 text-ink-soft">{PAYOUT_ACCOUNT_TEXT.unknown}</p>
          : load.consent.state === "current" ? (
            <div className="grid gap-2 py-2">
              <p>{PAYOUT_ACCOUNT_TEXT.consentCurrent}（{japanDate(load.consent.consentedAtUtc)}）</p>
              <form method="post" action={HOST_PAYOUT_CONSENT_PATH} className="grid gap-2" data-niho-navigation-form>
                {formFields("withdraw")}
                <p className="text-sm text-ink-soft">{PAYOUT_ACCOUNT_TEXT.withdrawWarning}</p>
                <div><button type="submit" className={consoleButtonClass("secondary", "sm")}>同意を取り消す</button></div>
              </form>
            </div>
          )
          : load.consentVersion === "" ? <p className="py-2 text-ink-soft">{PAYOUT_ACCOUNT_TEXT.consentUnavailable}</p>
          : (
            <form method="post" action={HOST_PAYOUT_CONSENT_PATH} className="grid gap-3 py-2" data-niho-navigation-form>
              {formFields("consent")}
              <p className={load.consent.state === "outdated" ? "text-warn" : "text-ink-soft"}>
                {load.consent.state === "outdated" ? PAYOUT_ACCOUNT_TEXT.consentOutdated : PAYOUT_ACCOUNT_TEXT.consentNone}
              </p>
              <p className="rounded-xl border border-line bg-canvas p-3 text-sm leading-relaxed">{consentText}</p>
              <label className="flex items-start gap-2 font-bold">
                <input type="checkbox" name="accepted" value="yes" required className="mt-1 size-4" />
                上の内容を確認し、この口座で売上を受け取ることに同意します
              </label>
              <div><button type="submit" className={consoleButtonClass("primary", "sm")}>同意する</button></div>
            </form>
          )}
        <p className="text-[0.78125rem] text-muted">{PAYOUT_ACCOUNT_TEXT.recentSignIn}</p>
      </FieldRow>
    </>
  );
}
