import { fullDateJa } from "@/host/format";
import type { HostNotice } from "@/host/payout";
import {
  CONNECT_PAYOUT_STATES,
  DIRECT_PAYOUT_STATES,
  experiencePayoutLines,
  experiencePayoutStatus,
  PAYOUT_ACCOUNT_TEXT,
  payoutAccountConsentText,
  type ConnectPayoutState,
  type DirectPayoutSection,
  type ExperiencePayoutLoad,
} from "@/host/payout-account";
import { hostApiPath } from "@/lib/host/api-path";
import { HOST_DIRECT_ONBOARDING_PATH, HOST_DIRECT_SELLER_PATH, HOST_PAYOUT_CONSENT_PATH, HOST_PAYOUT_ONBOARDING_PATH, HOST_SELLER_PATH, HOST_SETTINGS_PAYOUT_ANCHOR, withProvider } from "@/lib/host/routes";
import { FieldRow, FieldSection } from "./fields";
import { consoleButtonClass } from "./host-ui";
import { HostNoticeLine } from "./HostNoticeLine";
import { HostStripeLogin } from "./HostStripeLogin";

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
        : load.status === "connect" ? (
          <>
            {load.payout !== null ? <ConnectPayout providerId={providerId} state={load.payout} label="サポート 15% の受取口座" /> : null}
            {load.direct ? <DirectPayout providerId={providerId} section={load.direct} /> : null}
          </>
        )
        : <OwnerPayout providerId={providerId} load={load} />}
      <HostNoticeLine notice={notice} className="pt-1" />
    </FieldSection>
  );
}

/**
 * A host that registers its own payout account (Epic #700 stage 3a, #710, docs/host-payouts.md): what Stripe says in one
 * sentence, and the one button that goes with it. A plain form (no JavaScript): the POST asks for a sign-in within 30
 * minutes, then sends the OWNER to Stripe's own pages.
 */
function ConnectPayout({ providerId, state, label = "受取口座" }: { providerId: string; state: ConnectPayoutState; label?: string }) {
  const text = CONNECT_PAYOUT_STATES[state];
  return (
    <FieldRow label={label} labelId={label === "受取口座" ? "settings-payout-connect" : "settings-payout-express"}>
      <div className="grid gap-2 py-2">
        <p className={state === "READY" ? "text-ink-soft" : state === "REJECTED" ? "text-danger" : "text-warn"}>{text.line}</p>
        {text.action?.kind === "onboard" ? (
          <form method="post" action={hostApiPath(HOST_PAYOUT_ONBOARDING_PATH, providerId)} data-niho-navigation-form>
            <button type="submit" className={consoleButtonClass("primary", "sm")}>{text.action.label}</button>
          </form>
        ) : null}
        {text.action?.kind === "dashboard" ? (
          <HostStripeLogin providerId={providerId} kind="payout" label={text.action.label} className={consoleButtonClass("secondary", "sm")} />
        ) : null}
        {text.action?.kind === "onboard" ? <p className="text-[0.78125rem] text-muted">{PAYOUT_ACCOUNT_TEXT.recentSignInConnect}</p> : null}
      </div>
    </FieldRow>
  );
}

/**
 * The host's own Stripe account (Epic #700 stage 3c-1, #726, docs/host-payouts.md「3c」): one sentence and one button per state. At READY, the consent
 * (the payout-account consent's text and version) and 「同意する」, which creates the seller; with no seller disclosure yet, only the link to 販売者表示.
 * Plain forms (no JavaScript), both asking for a sign-in within 30 minutes.
 */
function DirectPayout({ providerId, section }: { providerId: string; section: DirectPayoutSection }) {
  const text = DIRECT_PAYOUT_STATES[section.state];
  const ready = section.state === "READY";
  const consentText = section.accountLast4 ? payoutAccountConsentText({ providerName: section.providerName, accountLast4: section.accountLast4 }) : "";
  return (
    <FieldRow label="独立 10%：自分の Stripe アカウント" labelId="settings-payout-direct">
      <div className="grid gap-2 py-2">
        <p className={ready ? "text-ink-soft" : section.state === "REJECTED" ? "text-danger" : "text-warn"}>{text.line}</p>
        {text.action ? (
          <form method="post" action={hostApiPath(HOST_DIRECT_ONBOARDING_PATH, providerId)} data-niho-navigation-form>
            <button type="submit" className={consoleButtonClass("primary", "sm")}>{text.action.label}</button>
          </form>
        ) : null}
        {ready && section.disclosure === "missing" ? (
          <>
            <p className="text-warn">{PAYOUT_ACCOUNT_TEXT.directDisclosureFirst}</p>
            <div><a href={withProvider(HOST_SELLER_PATH, providerId)} className={consoleButtonClass("primary", "sm")}>販売者表示を入力する</a></div>
          </>
        ) : null}
        {ready && section.disclosure === "ready" && section.accountLast4 && section.consentVersion !== "" ? (
          <form method="post" action={hostApiPath(HOST_DIRECT_SELLER_PATH, providerId)} className="grid gap-3" data-niho-navigation-form>
            <input type="hidden" name="accountLast4" value={section.accountLast4} />
            <input type="hidden" name="consentVersion" value={section.consentVersion} />
            <p className="rounded-xl border border-line bg-canvas p-3 text-sm leading-relaxed">{consentText}</p>
            <label className="flex items-start gap-2 font-bold">
              <input type="checkbox" name="accepted" value="yes" required className="mt-1 size-4" />
              上の内容を確認し、この口座で売上を受け取ることに同意します
            </label>
            <div><button type="submit" className={consoleButtonClass("primary", "sm")}>同意する</button></div>
          </form>
        ) : null}
        {ready && section.disclosure === "ready" && section.consentVersion === "" ? <p className="text-ink-soft">{PAYOUT_ACCOUNT_TEXT.consentUnavailable}</p> : null}
        {text.action || ready ? <p className="text-[0.78125rem] text-muted">{PAYOUT_ACCOUNT_TEXT.recentSignInConnect}</p> : null}
      </div>
    </FieldRow>
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
      {load.standard ? (
        <FieldRow label="ダッシュボード" labelId="settings-payout-dashboard">
          <div className="py-2"><HostStripeLogin providerId={providerId} kind="direct" label="Stripe で見る" className={consoleButtonClass("secondary", "sm")} /></div>
        </FieldRow>
      ) : null}
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
      {load.payout ? <ConnectPayout providerId={providerId} state={load.payout} label="サポート 15% の受取口座" /> : null}
    </>
  );
}
