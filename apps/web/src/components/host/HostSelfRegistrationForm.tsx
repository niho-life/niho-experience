"use client";

import { useId, useRef, useState, type FormEvent } from "react";
import { hostButtonClass } from "./host-ui";
import {
  nameAfterKindChange,
  REGISTRATION_EMAIL_MAX,
  REGISTRATION_NAME_MAX,
  registrationErrorCodeOrNull,
  registrationErrorMessage,
  type RegistrationErrorCode,
  type RegistrationErrorField,
  type RegistrationKind,
} from "@/lib/host/self-registration-form";
import { HOST_LOGIN_PATH, HOST_REGISTRATION_API_PATH, HOST_REGISTER_LOGIN_PATH, HOST_TERMS_PATH } from "@/lib/host/routes";

/*
 * 登録画面 (/host/start, Epic #700, #708) のフォーム。「どの名前で載せますか」: 個人として／会社・お店・団体として、掲載名、
 * 英語の掲載名、連絡用メールアドレス、ホスト規約への同意。個人のときだけ NIHO の表示名を掲載名の初期値にし（書き換えてよい。登録を
 * 押すまで何も保存しない）、書き換えた値は種別を切り替えても消さない。送った結果の言葉は self-registration-form.ts。
 * 登録できたら、サーバーが答えたホームへ移る（セッションの cookie は、その答えで置かれる）。
 */

const INPUT = "min-h-12 w-full rounded-xl border border-line-strong bg-canvas px-3 font-normal";

type Failure = { code: RegistrationErrorCode; field?: RegistrationErrorField; limit?: number };

export function HostSelfRegistrationForm({ nihoDisplayName, termsVersion, mode }: { nihoDisplayName: string | null; termsVersion: string; mode: "niho" | "account" }) {
  const ids = useId();
  const [kind, setKind] = useState<RegistrationKind>("PERSON");
  const [name, setName] = useState(nihoDisplayName ?? "");
  const nameEdited = useRef(false);
  const [nameEn, setNameEn] = useState("");
  const [email, setEmail] = useState("");
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);

  const chooseKind = (next: RegistrationKind) => {
    setKind(next);
    setName((current) => nameAfterKindChange(next, nihoDisplayName, { name: current, edited: nameEdited.current }));
  };

  const ready = name.trim() !== "" && email.trim() !== "" && agreed && !busy;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!ready) return;
    setBusy(true);
    setFailure(null);
    try {
      const response = await fetch(HOST_REGISTRATION_API_PATH, {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          providerKind: kind,
          publicDisplayName: name.trim(),
          publicDisplayNameEn: nameEn.trim() === "" ? null : nameEn.trim(),
          notificationEmail: email.trim(),
          hostTermsVersion: termsVersion,
          termsAccepted: agreed,
        }),
      });
      const body: unknown = await response.json().catch(() => null);
      if (response.ok && typeof body === "object" && body !== null && typeof (body as { redirect?: unknown }).redirect === "string") {
        const redirect = (body as { redirect: string }).redirect;
        // Only this site's own page: a path, never a URL.
        window.location.assign(redirect.startsWith("/") && !redirect.startsWith("//") ? redirect : "/host/home");
        return;
      }
      const error = typeof body === "object" && body !== null ? (body as { error?: { code?: unknown; field?: unknown; limit?: unknown } }).error : undefined;
      const code = registrationErrorCodeOrNull(error?.code) ?? "UNAVAILABLE";
      const field = error?.field === "name" || error?.field === "nameEn" || error?.field === "email" || error?.field === "terms" ? error.field : undefined;
      setFailure({ code, ...(field ? { field } : {}), ...(typeof error?.limit === "number" ? { limit: error.limit } : {}) });
    } catch {
      setFailure({ code: "UNAVAILABLE" });
    } finally {
      setBusy(false);
    }
  }

  const message = failure ? registrationErrorMessage(failure.code, { ...(failure.limit ? { limit: failure.limit } : {}) }) : null;
  const under = (field: RegistrationErrorField) => (failure?.field === field && message ? <p id={`${ids}-${field}-error`} role="alert" className="text-[0.8125rem] font-bold text-danger">{message}</p> : null);
  const describedBy = (field: RegistrationErrorField, help?: string) => [failure?.field === field && message ? `${ids}-${field}-error` : null, help ?? null].filter(Boolean).join(" ") || undefined;
  const business = kind === "BUSINESS";

  return (
    <form onSubmit={submit} noValidate className="text-left">
      {mode === "niho" ? (
        <p className="rounded-2xl border border-line bg-canvas px-3.5 py-3 text-[0.875rem] text-ink-soft">
          NIHO アカウントでログインしています。
          <a href={HOST_REGISTER_LOGIN_PATH + "&switch=1"} className="ml-1 font-bold text-moss underline underline-offset-4">別のアカウントで続ける</a>
        </p>
      ) : (
        <p className="rounded-2xl border border-line bg-canvas px-3.5 py-3 text-[0.875rem] text-ink-soft">いまのアカウントに、ホストをもう 1 つ足します。</p>
      )}

      <fieldset className="mt-5">
        <legend className="text-[0.9375rem] font-extrabold">どの名前で載せますか</legend>
        <div className="mt-2.5 grid gap-2.5">
          {([
            ["PERSON", "個人として", "あなたの名前や活動名で載せます。"],
            ["BUSINESS", "会社・お店・団体として", "屋号や会社名で載せます。あなたはこのホストのオーナーになります。"],
          ] as const).map(([value, title, detail]) => (
            <label key={value} className={`flex cursor-pointer items-start gap-3 rounded-2xl border-[1.5px] p-3.5 focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-moss ${kind === value ? "border-moss bg-leaf-pale" : "border-line-strong bg-canvas"}`}>
              <input type="radio" name="providerKind" value={value} checked={kind === value} onChange={() => chooseKind(value)} className="mt-1 size-[18px] accent-moss" />
              <span><b className="block">{title}</b><span className="text-[0.8125rem] text-ink-soft">{detail}</span></span>
            </label>
          ))}
        </div>
      </fieldset>

      <div className="mt-5 grid gap-1.5">
        <label htmlFor={`${ids}-name`} className="text-[0.875rem] font-extrabold">掲載名<span className="ml-1.5 text-[0.75rem] font-bold text-warn">必須</span>
          {!business && mode === "niho" && nihoDisplayName !== null && name === nihoDisplayName ? <span className="ml-2 rounded-full bg-leaf-pale px-2 py-0.5 text-[0.71875rem] font-bold text-moss">NIHO のプロフィールから</span> : null}
        </label>
        <input
          id={`${ids}-name`} name="publicDisplayName" value={name} maxLength={REGISTRATION_NAME_MAX} autoComplete="off" required
          placeholder={business ? "例：葉山クラフト" : "例：森 ゆき"}
          aria-invalid={failure?.field === "name" || undefined} aria-describedby={describedBy("name", `${ids}-name-help`)}
          onChange={(event) => { nameEdited.current = true; setName(event.target.value); }}
          className={INPUT}
        />
        {under("name")}
        <p id={`${ids}-name-help`} className="text-[0.78125rem] text-muted">
          {business ? "お店や会社の、ふだん呼ばれている名前。法人の正式名は、予約の受付を始めるときに販売者情報で入れます。" : "本名でも、活動名でもかまいません。"}
        </p>
      </div>

      <div className="mt-4 grid gap-1.5">
        <label htmlFor={`${ids}-name-en`} className="text-[0.875rem] font-extrabold">英語の掲載名<span className="ml-1.5 text-[0.75rem] font-bold text-muted">任意</span></label>
        <input
          id={`${ids}-name-en`} name="publicDisplayNameEn" value={nameEn} maxLength={REGISTRATION_NAME_MAX} autoComplete="off" lang="en"
          placeholder={business ? "例：Hayama Craft" : "例：Yuki Mori"}
          aria-invalid={failure?.field === "nameEn" || undefined} aria-describedby={describedBy("nameEn", `${ids}-name-en-help`)}
          onChange={(event) => setNameEn(event.target.value)}
          className={INPUT}
        />
        {under("nameEn")}
        <p id={`${ids}-name-en-help`} className="text-[0.78125rem] text-muted">空なら、英語のページにも上の名前を出します。</p>
      </div>

      <div className="mt-4 grid gap-1.5">
        <label htmlFor={`${ids}-email`} className="text-[0.875rem] font-extrabold">連絡用メールアドレス<span className="ml-1.5 text-[0.75rem] font-bold text-warn">必須</span></label>
        <input
          id={`${ids}-email`} name="notificationEmail" type="email" value={email} maxLength={REGISTRATION_EMAIL_MAX} autoComplete="email" inputMode="email" spellCheck={false} required
          placeholder="you@example.com"
          aria-invalid={failure?.field === "email" || undefined} aria-describedby={describedBy("email", `${ids}-email-help`)}
          onChange={(event) => setEmail(event.target.value)}
          className={INPUT}
        />
        {under("email")}
        <p id={`${ids}-email-help`} className="text-[0.78125rem] text-muted">予約や相談の知らせが届きます。確認のメールを送ります。</p>
      </div>

      <div className="mt-5">
        <label className="flex items-start gap-2.5 text-[0.875rem]">
          <input type="checkbox" checked={agreed} onChange={(event) => setAgreed(event.target.checked)} aria-describedby={describedBy("terms")} className="mt-0.5 size-5 shrink-0 accent-moss" />
          <span>
            <a href={HOST_TERMS_PATH} target="_blank" rel="noreferrer" className="font-bold text-moss underline underline-offset-4">ホスト規約</a>
            と
            <a href="/privacy" target="_blank" rel="noreferrer" className="font-bold text-moss underline underline-offset-4">プライバシーポリシー</a>
            に同意します
          </span>
        </label>
        <div className="mt-1.5">{under("terms")}</div>
      </div>

      {message && !failure?.field ? (
        <div role="alert" className="mt-5 rounded-xl bg-warn-pale p-3 text-[0.875rem] text-ink">
          <p>{message}</p>
          {failure?.code === "ALREADY_REGISTERED" || failure?.code === "REGISTRATION_EXPIRED" ? (
            <p className="mt-2"><a href={failure.code === "ALREADY_REGISTERED" ? HOST_LOGIN_PATH : HOST_REGISTER_LOGIN_PATH} className="font-bold text-moss underline underline-offset-4">{failure.code === "ALREADY_REGISTERED" ? "ログイン" : "もう一度ログイン"}</a></p>
          ) : null}
        </div>
      ) : null}

      <button type="submit" disabled={!ready} aria-disabled={!ready} className={hostButtonClass("primary", "mt-6 w-full disabled:cursor-not-allowed disabled:opacity-50")}>
        {busy ? "登録しています…" : "登録する"}
      </button>
      {!ready && !busy ? <p className="mt-2 text-center text-[0.78125rem] text-muted">掲載名・連絡用メールアドレス・規約への同意が必要です。</p> : null}
    </form>
  );
}
