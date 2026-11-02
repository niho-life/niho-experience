"use client";

import { useId, useState, useTransition } from "react";
import { openPayoutConnect, sharePayoutAccount, syncPayoutAccount } from "@/host/actions";
import { payoutPanelView, type HostNotice, type HostPayoutLoad } from "@/host/payout";
import { DISABLED } from "./editor-parts";
import { FieldRow, FieldSection, SELECT } from "./fields";
import { consoleButtonClass } from "./host-ui";
import { HostIcon } from "./HostIcon";
import { HostNoticeLine } from "./HostNoticeLine";
import { HostStripeLogin } from "./HostStripeLogin";

/**
 * 設定 › 売上受取口座 (#88/#91, mock v2): the owner's payout account as NIHO has it, and what
 * the owner can do next: share one of their spots' ready seller accounts (with NIHO's consent),
 * open Stripe's page (the first time, or to continue the identity check) or read the state again.
 * Stripe's page opens in this tab and sends the host back to 設定 (`?connect=`). Anyone else sees
 * that the state is the owner's to check.
 */
export function HostPayoutPanel({
  providerId,
  displayName,
  payout,
  onPayout,
  initialNotice,
  preview,
}: {
  providerId: string;
  /** Names the provider's own account ("サンプルの台所の口座"). */
  displayName: string;
  payout: HostPayoutLoad;
  onPayout: (payout: HostPayoutLoad) => void;
  /** What Stripe's way back (`?connect=`) led to. */
  initialNotice: HostNotice | null;
  /** Synthetic preview keeps the generic login link; live mode requests a server-side link. */
  preview: boolean;
}) {
  const baseId = useId();
  const view = payoutPanelView(payout, displayName);
  const shareable = payout.status === "owner" && view.actions.includes("share") ? payout.payout : null;
  const [spotId, setSpotId] = useState("");
  const [agreed, setAgreed] = useState(false);
  const [notice, setNotice] = useState<HostNotice | null>(initialNotice);
  const [pending, startTransition] = useTransition();
  // Set while the browser leaves for Stripe's page: nothing else may start.
  const [leaving, setLeaving] = useState(false);
  const busy = pending || leaving;

  const afterChange = (result: { ok: true; message: string; payout: HostPayoutLoad | null }) => {
    if (result.payout) onPayout(result.payout);
    setSpotId("");
    setAgreed(false);
    setNotice({ tone: "success", message: result.message });
  };

  const share = () => {
    if (!shareable?.reuseConsent || !spotId || !agreed) return;
    const consentVersion = shareable.reuseConsent.version;
    setNotice(null);
    startTransition(async () => {
      const result = await sharePayoutAccount({ providerId, sourceSpotId: spotId, consentVersion });
      if (result.ok) afterChange(result);
      else setNotice({ tone: "error", message: result.message });
    });
  };

  const openStripe = (step: "start" | "resume") => {
    setNotice(null);
    startTransition(async () => {
      const result = await openPayoutConnect({ providerId, step });
      if (!result.ok) {
        setNotice({ tone: "error", message: result.message });
      } else if (result.redirectTo) {
        setLeaving(true);
        setNotice({ tone: "success", message: result.message });
        window.location.assign(result.redirectTo);
      } else {
        afterChange(result);
      }
    });
  };

  const sync = () => {
    setNotice(null);
    startTransition(async () => {
      const result = await syncPayoutAccount({ providerId });
      if (result.ok) afterChange(result);
      else setNotice({ tone: "error", message: result.message });
    });
  };

  const button = consoleButtonClass("secondary", "sm", DISABLED);
  const stripeLabel = `${baseId}-stripe`;
  return (
    <FieldSection id="settings-payout" title="売上受取口座" status={view.status}>
      <FieldRow label="Stripe" labelId={stripeLabel}>
        <div role="group" aria-labelledby={stripeLabel} className="flex min-h-10 flex-wrap items-center gap-x-2.5 gap-y-2">
          <span className={view.status ? "" : "text-ink-soft"}>{view.text}</span>
          {view.dashboard ? (
            <HostStripeLogin
              providerId={preview ? null : providerId}
              label="Stripe で確認"
              className={consoleButtonClass("secondary", "sm")}
            />
          ) : null}
          {view.actions.includes("connect") ? (
            <button type="button" disabled={busy} onClick={() => openStripe("start")} className={button}>
              <HostIcon name="external" className="size-3.5" />
              Stripe で口座を接続
            </button>
          ) : null}
          {view.actions.includes("resume") ? (
            <button type="button" disabled={busy} onClick={() => openStripe("resume")} className={button}>
              <HostIcon name="external" className="size-3.5" />
              Stripe で本人確認を続ける
            </button>
          ) : null}
          {view.actions.includes("sync") ? (
            <button type="button" disabled={busy} onClick={sync} className={button}>
              状態を再確認
            </button>
          ) : null}
        </div>
      </FieldRow>

      {shareable?.reuseConsent ? (
        <FieldRow label="既存の口座を使う" htmlFor={`${baseId}-spot`}>
          <div className="flex flex-col items-start gap-2.5">
            <select id={`${baseId}-spot`} value={spotId} disabled={busy} onChange={(event) => setSpotId(event.currentTarget.value)} className={SELECT}>
              <option value="">共有する拠点の口座を選ぶ</option>
              {shareable.candidates.map((spot) => (
                <option key={spot.id} value={spot.id}>
                  {spot.name}
                </option>
              ))}
            </select>
            <label className="flex items-start gap-2.5 text-[0.8125rem] leading-relaxed text-ink-soft">
              <input type="checkbox" checked={agreed} disabled={busy} onChange={(event) => setAgreed(event.currentTarget.checked)} className="mt-0.5 size-5 shrink-0 accent-moss" />
              <span>{shareable.reuseConsent.text}</span>
            </label>
            <button type="button" disabled={busy || !spotId || !agreed} onClick={share} className={button}>
              共有する
            </button>
          </div>
        </FieldRow>
      ) : null}

      <HostNoticeLine notice={notice} className="pt-1" />
    </FieldSection>
  );
}
