"use client";

import { useEffect, useRef, useState, useTransition, type FormEvent } from "react";
import { registerProvider } from "@/host/actions";
import { FieldRow, FieldSection, INPUT, KindSegment, NARROW } from "./fields";
import { consoleButtonClass } from "./host-ui";

const field = (data: FormData, name: string) => {
  const value = data.get(name);
  return typeof value === "string" ? value : "";
};

/**
 * Legacy provider registration preview (#88). The current Experience host contract does not
 * support registration; the old NIHO bio field is intentionally not collected here because
 * provider introductions are managed at /host/profile.
 * 登録する sends the remaining fields to NIHO's provider API (registerProvider) and opens the
 * new provider's home; a refusal is said in one sentence above the button and nothing typed is
 * lost. In the preview the contract mock forgets the new provider after the request, so the
 * synthetic host signs in again with a provider in the state a new one starts in.
 */
export function HostRegisterForm({ consent, preview }: { consent: { version: string; text: string }; preview: boolean }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  // Set once NIHO has the provider and the browser is on its way to the new home.
  const [leaving, setLeaving] = useState(false);
  const errorRef = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);

  // The browser has checked the fields and the consent before this runs.
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending || leaving) return;
    const data = new FormData(event.currentTarget);
    setError(null);
    startTransition(async () => {
      const result = await registerProvider({
        kind: field(data, "kind"),
        displayName: field(data, "displayName"),
        // Keep the legacy preview contract shape without collecting a second provider intro.
        bio: "",
        sellerDisclosureUrl: field(data, "sellerDisclosureUrl"),
        consentVersion: consent.version,
      });
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setLeaving(true);
      window.location.assign(result.next);
    });
  };

  const busy = pending || leaving;
  return (
    <form className="flex flex-col gap-3.5" onSubmit={submit}>
      <FieldSection id="register-provider" title="提供者情報">
        <FieldRow label="種別" labelId="register-kind-label">
          <KindSegment name="kind" labelId="register-kind-label" defaultValue="INDIVIDUAL" />
        </FieldRow>
        <FieldRow label="掲載名" htmlFor="register-display-name">
          <input
            id="register-display-name"
            name="displayName"
            required
            maxLength={100}
            pattern=".*\S.*"
            title="掲載名を入力してください"
            autoComplete="organization"
            aria-describedby="register-display-name-help"
            className={`${INPUT} ${NARROW}`}
          />
          <p id="register-display-name-help" className="mt-1 text-xs text-muted">
            体験ページに「提供者」として表示する名前です。
          </p>
        </FieldRow>
        <FieldRow label="特商法表示 URL" htmlFor="register-seller-url">
          <input
            id="register-seller-url"
            name="sellerDisclosureUrl"
            type="url"
            inputMode="url"
            placeholder="https://"
            pattern="https://.+"
            title="https:// で始まる URL を入力してください"
            maxLength={2048}
            aria-describedby="register-seller-url-help"
            className={`${INPUT} ${NARROW}`}
          />
          <p id="register-seller-url-help" className="mt-1 text-xs text-muted">
            掲載の審査までに https のページを用意してください。
          </p>
        </FieldRow>
      </FieldSection>
      <label className="flex items-start gap-3 rounded-2xl bg-sand p-4 text-[0.84375rem] leading-relaxed text-ink-soft md:px-5">
        <input type="checkbox" required className="mt-0.5 size-5 shrink-0 accent-moss" />
        <span>{consent.text}</span>
      </label>
      {error ? (
        <p ref={errorRef} role="alert" tabIndex={-1} className="rounded-2xl border border-danger/20 bg-danger-pale px-4 py-3 font-bold text-danger">
          {error}
        </p>
      ) : null}
      <div>
        <button type="submit" disabled={busy} className={consoleButtonClass("primary", "lg", "w-full disabled:opacity-60 md:w-auto")}>
          {busy ? "登録しています…" : "登録する"}
        </button>
        {preview ? (
          <p className="mt-2 text-xs text-muted">プレビューでは登録の内容は保存されません。登録のあとは、登録したばかりの状態の合成の提供者で続きを試せます。</p>
        ) : null}
      </div>
    </form>
  );
}
