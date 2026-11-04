"use client";

import { useEffect, useRef, useState } from "react";
import { consoleButtonClass } from "./host-ui";
import {
  beginSellerCommand,
  pendingSellerCommandAfter,
  sellerCommandOutcome,
  type PendingSellerCommand,
  type SellerDisclosure,
  type SellerKind,
} from "./seller-disclosure-command";

type Load = { seller: { sellerDisplayName: string; disclosure: SellerDisclosure | null }; consentVersion: string };

const FIELD = "min-h-11 w-full rounded-xl border border-line-strong bg-canvas px-3 py-2 disabled:bg-sand";
const EMPTY = { representativeName: "", publicAddress: "", publicPhone: "", publicEmail: "", externalUrl: "" };

export function HostSellerDisclosureForm() {
  const [loaded, setLoaded] = useState<Load | null>(null);
  const [method, setMethod] = useState<"NATIVE" | "EXTERNAL">("NATIVE");
  const [sellerKind, setSellerKind] = useState<SellerKind>("PERSON");
  const [fields, setFields] = useState(EMPTY);
  const [accepted, setAccepted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pendingCommand, setPendingCommand] = useState<PendingSellerCommand | null>(null);
  const pendingCommandRef = useRef<PendingSellerCommand | null>(null);
  const [message, setMessage] = useState("読み込み中です…");

  const rememberPending = (command: PendingSellerCommand | null) => {
    pendingCommandRef.current = command;
    setPendingCommand(command);
  };
  const clearPrivateView = (text: string) => {
    rememberPending(null); setLoaded(null); setFields(EMPTY); setAccepted(false); setMessage(text);
  };
  const apply = (value: Load, status = "") => {
    setLoaded(value);
    const disclosure = value.seller.disclosure;
    if (disclosure && disclosure.method !== "WITHDRAWN") {
      setMethod(disclosure.method);
      setSellerKind(disclosure.sellerKind);
      setFields({
        representativeName: disclosure.representativeName ?? "", publicAddress: disclosure.publicAddress ?? "",
        publicPhone: disclosure.publicPhone ?? "", publicEmail: disclosure.publicEmail ?? "", externalUrl: disclosure.externalUrl ?? "",
      });
    } else {
      setMethod("NATIVE"); setSellerKind("PERSON"); setFields(EMPTY);
    }
    setAccepted(false);
    setMessage(status || (disclosure?.method === "WITHDRAWN" ? "販売者表示は撤回されています。" : ""));
  };
  const reload = async (status = "") => {
    if (pendingCommandRef.current) {
      setMessage("前回の通信結果が未確認です。同じ内容で結果を再確認してください。");
      return;
    }
    try {
      const response = await fetch("/host/api/seller", { cache: "no-store" });
      if (response.status === 401 || response.status === 403) return clearPrivateView("権限を確認できません。もう一度ログインしてください。");
      if (!response.ok) return setMessage("販売者表示を読み込めませんでした。時間をおいて再度お試しください。");
      apply(await response.json() as Load, status);
    } catch { setMessage("通信結果を確認できません。保存済みとは表示していません。再読込してください。"); }
  };
  useEffect(() => {
    const controller = new AbortController();
    void fetch("/host/api/seller", { cache: "no-store", signal: controller.signal }).then(async (response) => {
      if (response.status === 401 || response.status === 403) {
        setLoaded(null); setFields(EMPTY); setAccepted(false); setMessage("権限を確認できません。もう一度ログインしてください。");
        return;
      }
      if (!response.ok) { setMessage("販売者表示を読み込めませんでした。時間をおいて再度お試しください。"); return; }
      const value = await response.json() as Load;
      setLoaded(value);
      const disclosure = value.seller.disclosure;
      if (disclosure && disclosure.method !== "WITHDRAWN") {
        setMethod(disclosure.method); setSellerKind(disclosure.sellerKind);
        setFields({ representativeName: disclosure.representativeName ?? "", publicAddress: disclosure.publicAddress ?? "", publicPhone: disclosure.publicPhone ?? "", publicEmail: disclosure.publicEmail ?? "", externalUrl: disclosure.externalUrl ?? "" });
      }
      setMessage(disclosure?.method === "WITHDRAWN" ? "販売者表示は撤回されています。" : "");
    }).catch((caught: unknown) => {
      if (!(caught instanceof DOMException && caught.name === "AbortError")) setMessage("通信結果を確認できません。保存済みとは表示していません。再読込してください。");
    });
    return () => controller.abort();
  }, []);

  const runCommand = async (command: PendingSellerCommand) => {
    if (!loaded || busy) return;
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch("/host/api/seller", {
        method: command.method,
        headers: { "content-type": "application/json" },
        body: command.serializedBody,
      });
      let value: unknown = null;
      try { value = await response.json(); } catch { /* An invalid/missing response body is an unknown result. */ }
      const outcome = sellerCommandOutcome(response.status, value, command.expectedDisclosureMethod);
      rememberPending(pendingSellerCommandAfter(command, outcome));
      if (outcome.kind === "AUTH_REJECTED") {
        clearPrivateView("権限が失効しました。結果未確認のcommandと入力内容を画面から消去しました。");
        return;
      }
      if (outcome.kind === "CONFIRMED") {
        apply(
          { ...loaded, seller: { ...loaded.seller, disclosure: outcome.disclosure } },
          command.method === "DELETE" ? "販売者表示を撤回しました。公開ページからは参照できません。" : "公開への同意と販売者表示を保存しました。",
        );
        return;
      }
      if (outcome.kind === "REJECTED") {
        if (response.status === 409) {
          await reload("保存後に別の変更が反映されています。現在の保存値を読み直しました。");
        } else {
          setMessage("入力内容を確認してください。架空値や未入力項目は補完されません。");
        }
        return;
      }
      setMessage("通信結果を確認できません。入力を変更せず、同じcommandで結果を再確認してください。");
    } catch {
      setMessage("通信結果を確認できません。入力を変更せず、同じcommandで結果を再確認してください。");
    } finally {
      setBusy(false);
    }
  };

  const mutate = (httpMethod: "PUT" | "DELETE") => {
    if (!loaded || busy) return;
    const current = loaded.seller.disclosure;
    const bodyWithoutCommandId = httpMethod === "DELETE"
      ? { expectedVersion: current?.version }
      : {
          expectedVersion: current?.version ?? null,
          disclosure: method === "NATIVE" ? {
            method, sellerKind, sellerDisplayName: loaded.seller.sellerDisplayName,
            representativeName: sellerKind === "BUSINESS" ? fields.representativeName : null,
            publicAddress: fields.publicAddress, publicPhone: fields.publicPhone, publicEmail: fields.publicEmail,
            consentVersion: loaded.consentVersion, accepted,
          } : {
            method, sellerKind, sellerDisplayName: loaded.seller.sellerDisplayName, externalUrl: fields.externalUrl,
            consentVersion: loaded.consentVersion, accepted,
          },
        };
    const started = beginSellerCommand(pendingCommandRef.current, httpMethod, bodyWithoutCommandId, () => crypto.randomUUID());
    if (!started.created) {
      setMessage("前回の通信結果が未確認です。同じ内容で結果を再確認してください。");
      return;
    }
    rememberPending(started.command);
    void runCommand(started.command);
  };

  if (!loaded) return <div className="rounded-2xl border border-line bg-canvas p-5"><p role="status">{message}</p><button type="button" className={`${consoleButtonClass()} mt-4`} onClick={() => void reload()} disabled={busy}>再読込</button></div>;
  const active = loaded.seller.disclosure?.method !== "WITHDRAWN" && loaded.seller.disclosure !== null;
  const locked = busy || pendingCommand !== null;
  return <div className="space-y-4">
    <section className="rounded-2xl border border-line bg-canvas p-4 sm:p-5">
      <h2 className="font-extrabold">公開方法</h2>
      <p className="mt-2 rounded-xl bg-warn-pale p-3 text-sm font-bold">ここへ入力する氏名・住所・電話番号・メールアドレスは、旅行者に公開されます。NIHOの本人情報やStripeの確認情報は自動でコピーされません。</p>
      <fieldset className="mt-4 grid gap-2"><legend className="font-bold">表示方法</legend>
        <label className="flex min-h-11 items-center gap-2"><input type="radio" disabled={locked} checked={method === "NATIVE"} onChange={() => setMethod("NATIVE")} /> このサイトに公開情報を入力する</label>
        <label className="flex min-h-11 items-center gap-2"><input type="radio" disabled={locked} checked={method === "EXTERNAL"} onChange={() => setMethod("EXTERNAL")} /> 自分の既存の販売者表示（https）へ案内する</label>
      </fieldset>
    </section>
    <section className="rounded-2xl border border-line bg-canvas p-4 sm:p-5">
      <h2 className="font-extrabold">販売者情報</h2>
      <div className="mt-4 grid gap-4">
        <label className="grid gap-1 font-bold">販売者区分<select className={FIELD} disabled={locked} value={sellerKind} onChange={(event) => setSellerKind(event.target.value as SellerKind)}><option value="PERSON">個人</option><option value="BUSINESS">法人・事業者</option></select></label>
        <label className="grid gap-1 font-bold">氏名・名称<input className={FIELD} value={loaded.seller.sellerDisplayName} disabled /><span className="text-xs font-normal text-muted">Experienceの法的販売者名と一致させています。この画面では変更できません。</span></label>
        {method === "NATIVE" ? <>
          {sellerKind === "BUSINESS" ? <label className="grid gap-1 font-bold">業務責任者<input className={FIELD} disabled={locked} required maxLength={200} value={fields.representativeName} onChange={(event) => setFields({ ...fields, representativeName: event.target.value })} /></label> : null}
          <label className="grid gap-1 font-bold">公開用住所<textarea className={FIELD} disabled={locked} required maxLength={500} rows={3} value={fields.publicAddress} onChange={(event) => setFields({ ...fields, publicAddress: event.target.value })} /></label>
          <label className="grid gap-1 font-bold">公開用電話番号<input className={FIELD} disabled={locked} required maxLength={40} inputMode="tel" value={fields.publicPhone} onChange={(event) => setFields({ ...fields, publicPhone: event.target.value })} /></label>
          <label className="grid gap-1 font-bold">公開用メールアドレス<input className={FIELD} disabled={locked} required maxLength={254} type="email" value={fields.publicEmail} onChange={(event) => setFields({ ...fields, publicEmail: event.target.value })} /></label>
        </> : <label className="grid gap-1 font-bold">既存の販売者表示URL<input className={FIELD} disabled={locked} required maxLength={2048} type="url" inputMode="url" placeholder="https://example.jp/seller" value={fields.externalUrl} onChange={(event) => setFields({ ...fields, externalUrl: event.target.value })} /></label>}
      </div>
      <label className="mt-5 flex items-start gap-2 rounded-xl bg-sand p-3 font-bold"><input className="mt-1" disabled={locked} type="checkbox" checked={accepted} onChange={(event) => setAccepted(event.target.checked)} />入力内容が公開されることを確認し、この版の公開に同意します。</label>
      <div className="mt-5 flex flex-wrap gap-2"><button type="button" disabled={locked || !accepted} className={consoleButtonClass("primary", "lg")} onClick={() => mutate("PUT")}>確認して保存</button>{pendingCommand ? <button type="button" disabled={busy} className={consoleButtonClass("primary", "lg")} onClick={() => void runCommand(pendingCommand)}>同じ内容で結果を再確認</button> : null}<button type="button" disabled={locked} className={consoleButtonClass("secondary", "lg")} onClick={() => void reload("現在の保存値を読み直しました。")}>現在値を再読込</button></div>
      {message ? <p role="status" className="mt-4 font-bold">{message}</p> : null}
      {active ? <div className="mt-5 border-t border-line pt-4"><p className="text-sm text-ink-soft">撤回すると、販売者表示へのリンクと公開情報を直ちに参照できなくします。過去の予約内容や料金snapshotは変更しません。</p><button type="button" disabled={locked} className={`${consoleButtonClass("ghost")} mt-2 text-danger`} onClick={() => { if (window.confirm("公開中の販売者表示を撤回しますか？")) mutate("DELETE"); }}>販売者表示を撤回</button></div> : null}
    </section>
  </div>;
}
