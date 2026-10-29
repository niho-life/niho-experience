"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  type ChannelListingDto,
  type ExternalAccountDto,
  type InventoryAdminProvider,
  type InventoryAdminProduct,
  type InventoryAdminSnapshot,
  type InventoryResourceRecord,
} from "@niho-experience/experience-store";
import { CHANNEL_SITES } from "@niho-experience/experience-store/channel-sites";
import { useAdminLeaveProtection } from "./AdminLeaveGuard";
import { HOST_DIALOG } from "@/components/host/HostConfirmDialog";
import { consoleButtonClass, HOST_SURFACE } from "@/components/host/host-ui";

const WORKSPACE_API = "/admin/api/channel-workspace";
const CHANNEL_API = "/admin/api/channels";
const FIELD = "min-h-11 w-full min-w-0 rounded-xl border border-line-strong bg-canvas px-3 text-base md:text-sm";
const LABEL = "grid min-w-0 gap-1 text-xs font-extrabold text-ink-soft";

type Editor =
  | { kind: "account"; account?: ExternalAccountDto }
  | { kind: "listing"; listing?: ChannelListingDto }
  | { kind: "resource"; resource?: InventoryResourceRecord }
  | { kind: "inventory"; product: InventoryAdminProduct; resources: readonly InventoryResourceRecord[] };

interface PendingMutation {
  readonly endpoint: string;
  readonly body: Readonly<Record<string, unknown>>;
  readonly notice: string;
}

interface WorkspaceResponse {
  readonly providers: readonly InventoryAdminProvider[];
  readonly selected: InventoryAdminSnapshot | null;
}

function dateTimeLocal(value: string | undefined): string {
  if (!value) return "";
  const date = new Date(value);
  if (!Number.isFinite(date.valueOf())) return "";
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.valueOf() - offset).toISOString().slice(0, 16);
}

function optionalInstant(value: FormDataEntryValue | null): string | undefined {
  const text = String(value ?? "").trim();
  if (!text) return undefined;
  const date = new Date(text);
  return Number.isFinite(date.valueOf()) ? date.toISOString() : undefined;
}

function stateLabel(active: boolean): ReactNode {
  return <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-extrabold ${active ? "bg-leaf-pale text-moss" : "bg-sand text-ink-soft"}`}>
    <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-current" />{active ? "有効" : "停止"}
  </span>;
}

function accountState(account: ExternalAccountDto): ReactNode {
  if (account.revokedAtUtc) return <span className="inline-flex items-center gap-1.5 rounded-full bg-danger-pale px-2 py-0.5 text-xs font-extrabold text-danger"><span aria-hidden className="h-1.5 w-1.5 rounded-full bg-current" />失効</span>;
  if (account.delegatedUntilUtc && Date.parse(account.delegatedUntilUtc) <= Date.now()) return <span className="text-xs font-extrabold text-warn">期限切れ</span>;
  if (account.quarantined) return <span className="inline-flex items-center gap-1.5 rounded-full bg-warn-pale px-2 py-0.5 text-xs font-extrabold text-warn"><span aria-hidden className="h-1.5 w-1.5 rounded-full bg-current" />要確認</span>;
  return stateLabel(account.active);
}

function WorkspaceDialog({ title, busy, submitLabel, onClose, onSubmit, feedback, children }: {
  title: string;
  busy: boolean;
  submitLabel: string;
  onClose: () => void;
  onSubmit: (form: FormData) => void;
  children: ReactNode;
  feedback: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const element = dialog.current;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    queueMicrotask(() => { if (element?.isConnected && !element.open) { element.showModal(); cancel.current?.focus(); } });
    return () => { if (previous?.isConnected) previous.focus(); };
  }, []);
  return <dialog ref={dialog} aria-labelledby="channel-workspace-dialog-title" onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }} onClose={onClose} className={HOST_DIALOG}>
    <form data-admin-inline-save className="flex max-h-[calc(100dvh-2rem)] flex-col" onSubmit={(event) => {
      event.preventDefault();
      if (!busy && event.currentTarget.reportValidity()) onSubmit(new FormData(event.currentTarget));
    }}>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 pt-4 pb-4 md:px-5 md:pt-5">
        <h2 id="channel-workspace-dialog-title" className="text-[0.9375rem] font-extrabold">{title}</h2>
        {feedback}
        <fieldset disabled={busy} className="contents">{children}</fieldset>
      </div>
      <div className="flex flex-wrap justify-end gap-2 border-t border-line px-4 py-3 md:px-5">
        <button ref={cancel} type="button" disabled={busy} onClick={onClose} className={consoleButtonClass("secondary", "md", "min-h-11")}>やめる</button>
        <button type="submit" disabled={busy} className={consoleButtonClass("primary", "md", "min-h-11")}>{busy ? "保存中…" : submitLabel}</button>
      </div>
    </form>
  </dialog>;
}

export function AdminChannelWorkspace({ initialProviders }: { initialProviders: readonly InventoryAdminProvider[] }) {
  const [providers, setProviders] = useState(initialProviders);
  const [providerId, setProviderId] = useState(initialProviders[0]?.id ?? "");
  const [snapshot, setSnapshot] = useState<InventoryAdminSnapshot | null>(null);
  const [accounts, setAccounts] = useState<readonly ExternalAccountDto[]>([]);
  const [listings, setListings] = useState<readonly ChannelListingDto[]>([]);
  const [loading, setLoading] = useState(Boolean(initialProviders[0]));
  const [loadError, setLoadError] = useState(false);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<PendingMutation | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [needsSignIn, setNeedsSignIn] = useState(false);
  const request = useRef<{ sequence: number; controller: AbortController | null }>({ sequence: 0, controller: null });
  const busyRef = useRef(false);
  useAdminLeaveProtection(editor !== null || pending !== null, busy || pending !== null);

  const loadProvider = useCallback(async (selectedProvider: string): Promise<boolean> => {
    if (!selectedProvider) { setSnapshot(null); setAccounts([]); setListings([]); setLoading(false); return true; }
    request.current.controller?.abort();
    const controller = new AbortController();
    const sequence = ++request.current.sequence;
    request.current.controller = controller;
    setLoading(true); setLoadError(false);
    try {
      const [workspaceResponse, accountsResponse, listingsResponse] = await Promise.all([
        fetch(`${WORKSPACE_API}?providerId=${encodeURIComponent(selectedProvider)}`, { credentials: "same-origin", cache: "no-store", signal: controller.signal }),
        fetch(CHANNEL_API, { method: "POST", credentials: "same-origin", cache: "no-store", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "listAccounts", providerId: selectedProvider }), signal: controller.signal }),
        fetch(CHANNEL_API, { method: "POST", credentials: "same-origin", cache: "no-store", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "listListings", providerId: selectedProvider }), signal: controller.signal }),
      ]);
      if (!workspaceResponse.ok || !accountsResponse.ok || !listingsResponse.ok) throw new Error("load_failed");
      const workspace = await workspaceResponse.json() as WorkspaceResponse;
      const accountData = await accountsResponse.json() as { accounts: readonly ExternalAccountDto[] };
      const listingData = await listingsResponse.json() as { listings: readonly ChannelListingDto[] };
      if (sequence !== request.current.sequence || controller.signal.aborted) return false;
      if (workspace.selected?.providerId !== selectedProvider || accountData.accounts.some((item) => item.providerId !== selectedProvider) || listingData.listings.some((item) => item.providerId !== selectedProvider)) throw new Error("provider_mismatch");
      setProviders(workspace.providers);
      setSnapshot(workspace.selected);
      setAccounts(accountData.accounts);
      setListings(listingData.listings);
      setLoading(false);
      return true;
    } catch {
      if (controller.signal.aborted || sequence !== request.current.sequence) return false;
      setLoading(false); setLoadError(true);
      return false;
    }
  }, []);

  useEffect(() => {
    const tracker = request.current;
    const timer = window.setTimeout(() => void loadProvider(providerId), 0);
    return () => { window.clearTimeout(timer); tracker.controller?.abort(); };
  }, [loadProvider, providerId]);

  const mutate = useCallback(async (next: PendingMutation, retry = false) => {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setConflict(false); setMessage(null); setNeedsSignIn(false); setPending(next);
    try {
      const response = await fetch(next.endpoint, {
        method: "POST", credentials: "same-origin", cache: "no-store", headers: { "content-type": "application/json" }, body: JSON.stringify(next.body),
      });
      if (retry && response.status >= 400 && response.status < 500) {
        setNeedsSignIn(response.status === 401 || response.status === 403);
        setMessage("保存結果を確認できません。ログインと権限を確認してください。");
        return;
      }
      if (response.status === 409) {
        setPending(null); setConflict(true); setMessage("別の変更があります。入力は残っています。");
        return;
      }
      if (!response.ok) {
        if (response.status >= 400 && response.status < 500) {
          setPending(null); setMessage("保存できません。入力と現在の権限を確認してください。");
          return;
        }
        throw new Error("unknown_ack");
      }
      setPending(null); setEditor(null);
      const refreshed = await loadProvider(providerId);
      setMessage(refreshed ? next.notice : `${next.notice} 一覧を再読込してください。`);
    } catch {
      setMessage("保存結果を確認できません。");
    } finally {
      busyRef.current = false; setBusy(false);
    }
  }, [loadProvider, providerId]);

  const submit = (endpoint: string, body: Record<string, unknown>, notice: string) => void mutate({ endpoint, body: { ...body, commandId: crypto.randomUUID() }, notice });
  const locked = busy || pending !== null;
  const selectedProduct = editor?.kind === "inventory" ? editor.product : undefined;

  const feedback = <>
{message ? <div className="flex flex-wrap items-center gap-2 rounded-xl bg-sand px-3 py-2 text-sm font-bold" role="status"><span className="min-w-0 flex-1">{message}</span>{needsSignIn ? <a href="/admin" target="_blank" rel="noreferrer" className="inline-flex min-h-11 items-center underline underline-offset-4">ログイン</a> : null}{pending ? <button type="button" disabled={busy} className={consoleButtonClass("secondary", "md", "min-h-11")} onClick={() => void mutate(pending, true)}>結果を確認</button> : null}</div> : null}
    {conflict ? <button type="button" disabled={busy} onClick={() => void loadProvider(providerId)} className={consoleButtonClass("secondary", "md", "min-h-11")}>一覧を再読込</button> : null}
  </>;

  if (providers.length === 0) return <div className="mx-auto max-w-5xl px-4 py-8 md:px-7"><h1 className="text-2xl font-medium">掲載先</h1><p className="mt-5 text-ink-soft">設定できる提供者はありません。</p></div>;

  return <div className="mx-auto max-w-6xl space-y-5 px-4 py-8 md:px-7">
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div><h1 className="font-display text-2xl font-medium">掲載先</h1></div>
      <label className={`${LABEL} w-full sm:w-72`}>提供者
        <select value={providerId} disabled={locked} onChange={(event) => { request.current.controller?.abort(); request.current.sequence += 1; setSnapshot(null); setAccounts([]); setListings([]); setLoading(true); setEditor(null); setConflict(false); setMessage(null); setProviderId(event.currentTarget.value); }} className={FIELD}>
          {providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.displayName}</option>)}
        </select>
      </label>
    </div>

    {!editor ? feedback : null}
    {loading ? <p className="py-10 text-center text-ink-soft">読み込み中…</p> : null}
    {loadError ? <div role="alert" className="rounded-xl bg-danger-pale p-4"><p className="font-bold">一覧を読み込めませんでした。</p><button type="button" onClick={() => void loadProvider(providerId)} className={`${consoleButtonClass("secondary", "md", "min-h-11")} mt-3`}>再読込</button></div> : null}

    {!loading && !loadError && snapshot ? <>
      <section className={`${HOST_SURFACE} overflow-hidden`}>
        <div className="flex flex-wrap items-center justify-between gap-3 p-4"><div><h2 className="font-extrabold">体験と掲載先</h2><Link href={`/host/calendar?providerId=${encodeURIComponent(providerId)}`} className="text-xs font-bold text-moss underline underline-offset-2">開催枠を見る</Link></div><button type="button" disabled={locked || accounts.length === 0 || snapshot.products.length === 0} onClick={() => setEditor({ kind: "listing" })} className={consoleButtonClass("primary", "md", "min-h-11")}>掲載先を追加</button></div>
        <ul className="divide-y divide-line">{snapshot.products.map((product) => {
          const mapped = listings.filter((listing) => listing.productId === product.id);
          return <li key={product.id} className="flex min-w-0 flex-wrap items-center gap-3 px-4 py-3">
            <div className="min-w-0 flex-1"><p className="font-extrabold [overflow-wrap:anywhere]">{product.publicTitle}</p><p className="text-xs text-ink-soft">{mapped.length ? `${mapped.length}件の掲載設定` : "掲載設定なし"} · {product.inventory ? (product.inventory.bookingMode === "SEAT" ? "人数単位" : "1組単位") : "資源未設定"}</p></div>
            <button type="button" disabled={locked} onClick={() => setEditor({ kind: "inventory", product, resources: snapshot.resources })} className={consoleButtonClass("secondary", "md", "min-h-11")}>資源</button>
          </li>;
        })}{snapshot.products.length === 0 ? <li className="px-4 py-8 text-center text-ink-soft">体験はありません</li> : null}</ul>
      </section>

      <section className={`${HOST_SURFACE} overflow-hidden`}>
        <div className="flex flex-wrap items-center justify-between gap-3 p-4"><h2 className="font-extrabold">外部アカウント</h2><button type="button" disabled={locked} onClick={() => setEditor({ kind: "account" })} className={consoleButtonClass("secondary", "md", "min-h-11")}>追加</button></div>
        <ul className="divide-y divide-line">{accounts.map((account) => <li key={account.id} className="flex min-w-0 flex-wrap items-center gap-3 px-4 py-3"><div className="min-w-0 flex-1"><p className="font-extrabold [overflow-wrap:anywhere]">{account.displayName}</p><p className="text-xs text-ink-soft">{account.site} · 運営方式 {account.operatingModel} · {account.externalAccountId}{account.delegatedUntilUtc ? ` · 委託期限 ${new Date(account.delegatedUntilUtc).toLocaleDateString("ja-JP", { timeZone: "Asia/Tokyo" })}` : ""}</p></div>{accountState(account)}<button type="button" disabled={locked} onClick={() => setEditor({ kind: "account", account })} className={consoleButtonClass("secondary", "md", "min-h-11")}>設定</button></li>)}{accounts.length === 0 ? <li className="px-4 py-8 text-center text-ink-soft">アカウントはありません</li> : null}</ul>
      </section>

      <section className={`${HOST_SURFACE} overflow-hidden`}>
        <div className="p-4"><h2 className="font-extrabold">掲載設定</h2></div>
        <ul className="divide-y divide-line">{listings.map((listing) => {
          const product = snapshot.products.find((item) => item.id === listing.productId);
          const account = accounts.find((item) => item.id === listing.accountId);
          return <li key={listing.id} className="flex min-w-0 flex-wrap items-center gap-3 px-4 py-3"><div className="min-w-0 flex-1"><p className="font-extrabold [overflow-wrap:anywhere]">{product?.publicTitle ?? listing.productId}</p><p className="text-xs text-ink-soft">{account?.displayName ?? listing.accountId} · {listing.adapter}@{listing.adapterVersion} · {listing.connectionMode}</p></div>{stateLabel(listing.active)}<button type="button" disabled={locked} onClick={() => submit(CHANNEL_API, { action: "reconcile", listingId: listing.id }, "再照合を受け付けました。") } className={consoleButtonClass("secondary", "md", "min-h-11")}>再照合</button><button type="button" disabled={locked} onClick={() => setEditor({ kind: "listing", listing })} className={consoleButtonClass("secondary", "md", "min-h-11")}>設定</button></li>;
        })}{listings.length === 0 ? <li className="px-4 py-8 text-center text-ink-soft">掲載設定はありません</li> : null}</ul>
      </section>

      <section className={`${HOST_SURFACE} overflow-hidden`}>
        <div className="flex flex-wrap items-center justify-between gap-3 p-4"><div><h2 className="font-extrabold">共有資源</h2><Link href="/admin/operators" className="text-xs font-bold text-moss underline underline-offset-2">担当者を招待</Link></div><button type="button" disabled={locked} onClick={() => setEditor({ kind: "resource" })} className={consoleButtonClass("secondary", "md", "min-h-11")}>追加</button></div>
        <ul className="divide-y divide-line">{snapshot.resources.map((resource) => <li key={resource.id} className="flex min-w-0 flex-wrap items-center gap-3 px-4 py-3"><div className="min-w-0 flex-1"><p className="font-extrabold [overflow-wrap:anywhere]">{resource.displayName}</p><p className="text-xs text-ink-soft">{resource.kind === "VENUE" ? "会場" : resource.kind === "INSTRUCTOR" ? "講師" : "備品"}</p></div>{stateLabel(resource.active)}<button type="button" disabled={locked} onClick={() => setEditor({ kind: "resource", resource })} className={consoleButtonClass("secondary", "md", "min-h-11")}>設定</button></li>)}{snapshot.resources.length === 0 ? <li className="px-4 py-8 text-center text-ink-soft">共有資源はありません</li> : null}</ul>
      </section>
    </> : null}

    {editor?.kind === "account" ? <WorkspaceDialog feedback={feedback} title={editor.account ? "外部アカウントの設定" : "外部アカウントを追加"} busy={busy || pending !== null} submitLabel="保存" onClose={() => { if (!locked) setEditor(null); }} onSubmit={(form) => {
      const account = editor.account;
      const delegatedUntilUtc = optionalInstant(form.get("delegatedUntilUtc"));
      const input = { id: account?.id ?? crypto.randomUUID(), providerId, site: String(form.get("site")), externalAccountId: String(form.get("externalAccountId")).trim(), displayName: String(form.get("displayName")).trim(), operatingModel: Number(form.get("operatingModel")), active: account ? form.get("active") === "on" : false, ...(delegatedUntilUtc ? { delegatedUntilUtc } : {}) };
      submit(CHANNEL_API, account ? { action: "updateAccount", accountId: account.id, expectedVersion: account.version, account: input } : { action: "createAccount", account: input }, "保存しました。");
    }}>
      <label className={LABEL}>掲載サイト<select name="site" required defaultValue={editor.account?.site ?? CHANNEL_SITES[0]} className={FIELD}>{editor.account && !CHANNEL_SITES.includes(editor.account.site as (typeof CHANNEL_SITES)[number]) ? <option value={editor.account.site}>{editor.account.site}</option> : null}{CHANNEL_SITES.map((site) => <option key={site}>{site}</option>)}</select></label>
      <label className={LABEL}>表示名<input name="displayName" required maxLength={300} defaultValue={editor.account?.displayName ?? ""} className={FIELD} /></label>
      <label className={LABEL}>外部アカウントID<input name="externalAccountId" required maxLength={256} defaultValue={editor.account?.externalAccountId ?? ""} className={FIELD} /></label>
      <label className={LABEL}>運営方式<select name="operatingModel" defaultValue={editor.account?.operatingModel ?? 1} className={FIELD}>{["NIHO主体・運営者を招待", "運営者主体・共通ログイン", "運営者主体・NIHOを招待", "NIHO主体・実施を委託"].map((label, index) => <option key={label} value={index + 1}>{label}</option>)}</select></label>
      <label className={LABEL}>委託期限<input name="delegatedUntilUtc" type="datetime-local" defaultValue={dateTimeLocal(editor.account?.delegatedUntilUtc)} className={FIELD} /></label>
      {editor.account ? <label className="flex min-h-11 items-center gap-2 font-bold"><input name="active" type="checkbox" defaultChecked={editor.account.active} />有効にする</label> : <p className="text-xs text-ink-soft">停止で保存</p>}
    </WorkspaceDialog> : null}

    {editor?.kind === "listing" && snapshot ? <WorkspaceDialog feedback={feedback} title={editor.listing ? "掲載設定を編集" : "掲載先を追加"} busy={busy || pending !== null} submitLabel="保存" onClose={() => { if (!locked) setEditor(null); }} onSubmit={(form) => {
      const listing = editor.listing;
      const externalOptionId = String(form.get("externalOptionId") ?? "").trim();
      const input = { id: listing?.id ?? crypto.randomUUID(), providerId, productId: listing?.productId ?? String(form.get("productId")), accountId: listing?.accountId ?? String(form.get("accountId")), externalProductId: String(form.get("externalProductId")).trim(), ...(externalOptionId ? { externalOptionId } : {}), adapter: String(form.get("adapter")).trim(), adapterVersion: String(form.get("adapterVersion")).trim(), connectionMode: String(form.get("connectionMode")), capabilities: { canObserve: form.get("canObserve") === "on", canClose: form.get("canClose") === "on", canOpen: form.get("canOpen") === "on", canCreate: form.get("canCreate") === "on" }, active: listing ? form.get("active") === "on" : false };
      submit(CHANNEL_API, listing ? { action: "updateListing", listingId: listing.id, expectedVersion: listing.mappingVersion, listing: input } : { action: "createListing", listing: input }, "保存しました。");
    }}>
      <label className={LABEL}>体験<select name="productId" required defaultValue={editor.listing?.productId} disabled={Boolean(editor.listing)} className={FIELD}>{snapshot.products.map((product) => <option key={product.id} value={product.id}>{product.publicTitle}</option>)}</select></label>
      <label className={LABEL}>外部アカウント<select name="accountId" required defaultValue={editor.listing?.accountId} disabled={Boolean(editor.listing)} className={FIELD}>{accounts.map((account) => <option key={account.id} value={account.id}>{account.displayName} · {account.site}</option>)}</select></label>
      <label className={LABEL}>外部product ID<input name="externalProductId" required maxLength={256} defaultValue={editor.listing?.externalProductId ?? ""} className={FIELD} /></label>
      <label className={LABEL}>外部option ID<input name="externalOptionId" maxLength={256} defaultValue={editor.listing?.externalOptionId ?? ""} className={FIELD} /></label>
      <div className="grid min-w-0 gap-3 sm:grid-cols-2"><label className={LABEL}>adapter<input name="adapter" required maxLength={120} defaultValue={editor.listing?.adapter ?? ""} className={FIELD} /></label><label className={LABEL}>版<input name="adapterVersion" required maxLength={80} defaultValue={editor.listing?.adapterVersion ?? ""} className={FIELD} /></label></div>
      <label className={LABEL}>接続方式<select name="connectionMode" defaultValue={editor.listing?.connectionMode ?? "BROWSER"} className={FIELD}><option>BROWSER</option><option>GOOGLE</option><option>API</option></select></label>
      <fieldset><legend className="text-xs font-extrabold text-ink-soft">設定する能力</legend><div className="mt-1 grid grid-cols-2 gap-2">{(["canObserve", "canClose", "canOpen", "canCreate"] as const).map((capability) => <label key={capability} className="flex min-h-11 items-center gap-2"><input name={capability} type="checkbox" defaultChecked={editor.listing?.capabilities[capability] ?? false} />{{ canObserve: "確認", canClose: "閉じる", canOpen: "開く", canCreate: "作成" }[capability]}</label>)}</div></fieldset>
      {editor.listing ? <label className="flex min-h-11 items-center gap-2 font-bold"><input name="active" type="checkbox" defaultChecked={editor.listing.active} />有効にする</label> : <p className="text-xs text-ink-soft">停止で保存</p>}
    </WorkspaceDialog> : null}

    {editor?.kind === "resource" ? <WorkspaceDialog feedback={feedback} title={editor.resource ? "共有資源を編集" : "共有資源を追加"} busy={busy || pending !== null} submitLabel="保存" onClose={() => { if (!locked) setEditor(null); }} onSubmit={(form) => {
      const resource = editor.resource;
      submit(WORKSPACE_API, { action: "saveResource", providerId, expectedVersion: resource?.version ?? null, resource: { id: resource?.id ?? crypto.randomUUID(), kind: resource?.kind ?? String(form.get("kind")), displayName: String(form.get("displayName")).trim(), active: resource ? form.get("active") === "on" : false } }, "共有資源を保存しました。");
    }}>
      <label className={LABEL}>種類<select name="kind" defaultValue={editor.resource?.kind ?? "VENUE"} disabled={Boolean(editor.resource)} className={FIELD}><option value="VENUE">会場</option><option value="INSTRUCTOR">講師</option><option value="EQUIPMENT">備品</option></select></label>
      <label className={LABEL}>名前<input name="displayName" required maxLength={200} defaultValue={editor.resource?.displayName ?? ""} className={FIELD} /></label>
      {editor.resource ? <label className="flex min-h-11 items-center gap-2 font-bold"><input name="active" type="checkbox" defaultChecked={editor.resource.active} />有効にする</label> : <p className="text-xs text-ink-soft">停止で保存</p>}
    </WorkspaceDialog> : null}

    {editor?.kind === "inventory" && selectedProduct && snapshot ? <WorkspaceDialog feedback={feedback} title={`${selectedProduct.publicTitle}の資源`} busy={busy || pending !== null} submitLabel="保存" onClose={() => { if (!locked) setEditor(null); }} onSubmit={(form) => {
      const current = selectedProduct.inventory;
      const resources = editor.resources.flatMap((resource, index) => form.get(`use-${index}`) === "on" ? [{ resourceId: resource.id, prepareMinutes: Number(form.get(`prepare-${index}`)), cleanupMinutes: Number(form.get(`cleanup-${index}`)) }] : []);
      submit(WORKSPACE_API, { action: "saveProductInventory", providerId, productId: selectedProduct.id, expectedVersion: current?.version ?? null, inventory: { bookingMode: String(form.get("bookingMode")), resources } }, "体験の資源設定を保存しました。");
    }}>
      <label className={LABEL}>予約単位<select name="bookingMode" defaultValue={selectedProduct.inventory?.bookingMode ?? "SEAT"} className={FIELD}><option value="SEAT">人数単位</option><option value="PRIVATE_GROUP">1組単位</option></select></label>
      <fieldset><legend className="text-xs font-extrabold text-ink-soft">割り当て</legend><div className="mt-2 divide-y divide-line rounded-xl border border-line">{editor.resources.map((resource, index) => {
        const assigned = selectedProduct.inventory?.resources.find((item) => item.resourceId === resource.id);
        return <div key={resource.id} className="grid min-w-0 gap-2 p-3"><label className="flex min-h-11 min-w-0 items-center gap-2 font-bold"><input name={`use-${index}`} type="checkbox" defaultChecked={Boolean(assigned)} /> <span className="min-w-0 [overflow-wrap:anywhere]">{resource.displayName}</span></label><div className="grid min-w-0 grid-cols-2 gap-2"><label className={LABEL}>準備（分）<input name={`prepare-${index}`} type="number" min={0} max={1440} required defaultValue={assigned?.prepareMinutes ?? 0} className={FIELD} /></label><label className={LABEL}>片付け（分）<input name={`cleanup-${index}`} type="number" min={0} max={1440} required defaultValue={assigned?.cleanupMinutes ?? 0} className={FIELD} /></label></div></div>;
      })}{editor.resources.length === 0 ? <p className="p-3 text-sm text-ink-soft">共有資源はありません。</p> : null}</div></fieldset>

    </WorkspaceDialog> : null}
  </div>;
}
