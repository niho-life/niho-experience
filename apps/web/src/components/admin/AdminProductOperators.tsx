"use client";

import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode, type RefObject } from "react";
import type { ProductOperatorAdminSnapshot } from "@niho-experience/experience-store";
import type { StatusLabel } from "@/host/status";
import { HostConfirmDialog, HOST_DIALOG } from "@/components/host/HostConfirmDialog";
import { DANGER_BUTTON } from "@/components/host/HostBookingDialogs";
import { HostNoticeLine } from "@/components/host/HostNoticeLine";
import { HostIcon } from "@/components/host/HostIcon";
import { INPUT } from "@/components/host/fields";
import { consoleButtonClass, HOST_SURFACE, LIST_ROW, LIST_ROW_DETAIL, LIST_ROW_TITLE } from "@/components/host/host-ui";
import { HostPageBody, InitialAvatar, PageHead, SectionTitle, StatusPill } from "@/components/host/ui";
import type { HostNotice } from "@/host/payout";

const API = "/admin/api/operators";

type Product = ProductOperatorAdminSnapshot["products"][number];
type Invitation = ProductOperatorAdminSnapshot["invitations"][number];
type Grant = ProductOperatorAdminSnapshot["grants"][number];

const INVITED: StatusLabel = { label: "招待中", tone: "wait" };
const EXPIRED: StatusLabel = { label: "期限切れ", tone: "draft" };

/** Japan time, so the server's page and the browser's hydration print the same day. */
const DAY = new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", month: "numeric", day: "numeric" });
const untilText = (utc: string) => {
  const parts = DAY.formatToParts(new Date(utc));
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? "";
  return `${part("month")}月${part("day")}日まで`;
};
const isPast = (utc: string | undefined, now: number) => utc !== undefined && new Date(utc).getTime() <= now;

/** A request that has been sent or is being checked: the same `commandId` goes again until the result is known. */
type PendingRequest = Record<string, unknown>;

interface LinkView {
  /** null when the command was already saved: the link cannot be shown again. */
  link: string | null;
  assignmentLabel: string;
  productName: string;
}

/** A modal <dialog> on the page, the same way HostConfirmDialog opens one, for the invitation's two faces. */
function ModalDialog({ titleId, focusRef, locked = false, onClose, children }: { titleId: string; focusRef: RefObject<HTMLElement | null>; locked?: boolean; onClose: () => void; children: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled && element?.isConnected && !element.open) {
        element.showModal();
        focusRef.current?.focus();
      }
    });
    return () => {
      cancelled = true;
      if (previousFocus?.isConnected && (document.activeElement === document.body || element?.contains(document.activeElement))) previousFocus.focus();
    };
  }, [focusRef]);
  return (
    <dialog ref={dialog} aria-labelledby={titleId} onCancel={(event) => { event.preventDefault(); if (!locked) onClose(); }} className={HOST_DIALOG}>
      {children}
    </dialog>
  );
}

const DIALOG_BODY = "min-h-0 flex-1 overflow-y-auto px-4 pt-4 pb-4 md:px-5 md:pt-5";
const DIALOG_FOOT = "flex flex-wrap items-center justify-end gap-2 border-t border-line px-4 py-3 md:px-5";
const DIALOG_TITLE = "font-sans text-[0.9375rem] leading-normal font-extrabold tracking-normal";

function InviteFormDialog({ productName, busy, onSubmit, onClose }: { productName: string; busy: boolean; onSubmit: (assignmentLabel: string) => void; onClose: () => void }) {
  const titleId = useId();
  const input = useRef<HTMLInputElement>(null);
  const [name, setName] = useState("");
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy || name.trim() === "") return;
    onSubmit(name);
  };
  return (
    <ModalDialog titleId={titleId} focusRef={input} locked={busy} onClose={onClose}>
      <form className="flex max-h-[calc(100dvh-2rem)] flex-col" onSubmit={submit}>
        <div className={DIALOG_BODY}>
          <h2 id={titleId} className={DIALOG_TITLE}>運営者を招待</h2>
          <p className="mt-1 text-ink-soft [overflow-wrap:anywhere]">{productName}</p>
          <input ref={input} value={name} onChange={(event) => setName(event.target.value)} aria-label="担当者名" placeholder="担当者名" maxLength={100} required disabled={busy} className={`${INPUT} mt-3`} />
        </div>
        <div className={DIALOG_FOOT}>
          <button type="button" onClick={onClose} disabled={busy} className={consoleButtonClass("secondary")}>やめる</button>
          <button type="submit" disabled={busy || name.trim() === ""} className={`${consoleButtonClass("primary")} disabled:opacity-50`}>{busy ? "作成中…" : "招待リンクを作成"}</button>
        </div>
      </form>
    </ModalDialog>
  );
}

function InviteLinkDialog({ view, onClose }: { view: LinkView; onClose: () => void }) {
  const titleId = useId();
  const field = useRef<HTMLInputElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const [copy, setCopy] = useState<"idle" | "copied" | "select">("idle");
  const copyLink = async () => {
    if (!view.link) return;
    try {
      await navigator.clipboard.writeText(view.link);
      setCopy("copied");
    } catch {
      field.current?.focus();
      field.current?.select();
      setCopy("select");
    }
  };
  if (view.link === null) {
    return (
      <ModalDialog titleId={titleId} focusRef={closeButton} onClose={onClose}>
        <div className="flex max-h-[calc(100dvh-2rem)] flex-col">
          <div className={DIALOG_BODY}>
            <h2 id={titleId} className={DIALOG_TITLE}>招待リンク</h2>
            <p role="status" className="mt-1 text-ink-soft">保存済みです。リンクは再表示できません。必要なら招待を取り消して作り直してください。</p>
          </div>
          <div className={DIALOG_FOOT}>
            <button ref={closeButton} type="button" onClick={onClose} className={consoleButtonClass("secondary")}>閉じる</button>
          </div>
        </div>
      </ModalDialog>
    );
  }
  return (
    <ModalDialog titleId={titleId} focusRef={field} onClose={onClose}>
      <div className="flex max-h-[calc(100dvh-2rem)] flex-col">
        <div className={DIALOG_BODY}>
          <h2 id={titleId} className={DIALOG_TITLE}>招待リンク</h2>
          <p className="mt-1 text-ink-soft [overflow-wrap:anywhere]">{view.assignmentLabel} · {view.productName}</p>
          <input ref={field} readOnly value={view.link} aria-label="招待リンク" onFocus={(event) => event.currentTarget.select()} className={`${INPUT} mt-3`} />
          <p className="mt-2 text-[0.78125rem] leading-normal text-muted">7日間有効 · 閉じると再表示できません</p>
          <p role="status" className="text-[0.78125rem] leading-normal font-extrabold text-moss">{copy === "select" ? "リンクを選択してコピーしてください" : ""}</p>
        </div>
        <div className={DIALOG_FOOT}>
          <button type="button" onClick={onClose} className={consoleButtonClass("secondary")}>閉じる</button>
          <button type="button" onClick={() => void copyLink()} className={consoleButtonClass("primary")}>
            <HostIcon name={copy === "copied" ? "check" : "copy"} className="size-3.5" />
            {copy === "copied" ? "コピーしました" : "リンクをコピー"}
          </button>
        </div>
      </div>
    </ModalDialog>
  );
}

type Confirm =
  | { kind: "invitation"; item: Invitation }
  | { kind: "grant"; item: Grant };

export function AdminProductOperators({ initial, now: initialNow }: { initial: ProductOperatorAdminSnapshot; now: number }) {
  const [data, setData] = useState(initial);
  // Expiry is judged against the time the page was drawn (or the list last read), the same on the server and in the browser.
  const [now, setNow] = useState(initialNow);
  const [notice, setNotice] = useState<HostNotice | null>(null);
  const [busy, setBusy] = useState(false);
  const [pendingRequest, setPendingRequest] = useState<PendingRequest | null>(null);
  /** The last answer left the result unknown: 結果を確認 stays on the page until the same request is answered. */
  const [unknown, setUnknown] = useState(false);
  const [inviteFor, setInviteFor] = useState<Product | null>(null);
  const [linkView, setLinkView] = useState<LinkView | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);

  const keyOf = (item: { providerId: string; productId: string }) => `${item.providerId}:${item.productId}`;
  const activeGrants = data.grants.filter((item) => item.active);
  const pendingInvitations = data.invitations.filter((item) => item.state === "PENDING");
  // The list of experiences leaves out archived ones and stops at its limit, while people are read on their own:
  // an experience that is not listed still gets its surface (without 招待), so that its people can be ended.
  const listed = new Set(data.products.map(keyOf));
  const unlisted = new Map<string, Product>();
  for (const item of [...activeGrants, ...pendingInvitations]) {
    if (!listed.has(keyOf(item)) && !unlisted.has(keyOf(item))) unlisted.set(keyOf(item), { providerId: item.providerId, productId: item.productId, productTitle: item.productTitle, sellerDisplayName: item.sellerDisplayName });
  }
  const groups = [...data.products.map((product) => ({ product, invitable: true })), ...[...unlisted.values()].map((product) => ({ product, invitable: false }))];
  const titleCount = new Map<string, number>();
  for (const { product } of groups) titleCount.set(product.productTitle, (titleCount.get(product.productTitle) ?? 0) + 1);
  /** The experience's name; with the seller's only where two experiences share a title. */
  const nameOf = (item: { productTitle: string; sellerDisplayName: string }) => (titleCount.get(item.productTitle) ?? 0) > 1 ? `${item.productTitle} · ${item.sellerDisplayName}` : item.productTitle;

  const refresh = async () => {
    try {
      const response = await fetch(API, { cache: "no-store", credentials: "same-origin" });
      if (!response.ok) return false;
      setData(await response.json() as ProductOperatorAdminSnapshot);
      setNow(Date.now());
      return true;
    } catch { return false; }
  };

  const post = async (body: Record<string, unknown>) => {
    if (busy) return;
    const request = pendingRequest ?? { ...body, commandId: crypto.randomUUID() };
    setPendingRequest(request); setBusy(true); setNotice(null);
    try {
      const response = await fetch(API, { method: "POST", credentials: "same-origin", cache: "no-store", headers: { "content-type": "application/json" }, body: JSON.stringify(request) });
      // The body is read before the status, as before #542: an answer that is not JSON (a proxy's page) leaves the
      // result unknown, whatever its status, and the same `commandId` is sent again.
      const result = await response.json() as { link?: string; repeated?: boolean };
      if (!response.ok) {
        if (response.status >= 400 && response.status < 500) {
          setPendingRequest(null); setUnknown(false); setInviteFor(null); setConfirm(null);
          await refresh();
          setNotice({ tone: "error", message: "操作できません。権限と現在の状態を確認してください。" });
          return;
        }
        throw new Error("unknown_result");
      }
      setPendingRequest(null); setUnknown(false);
      const reloaded = await refresh();
      const reloadHint = reloaded ? "" : " 一覧を再読込してください。";
      if (request.action === "createInvitation") {
        const product = data.products.find((item) => item.providerId === request.providerId && item.productId === request.productId);
        setInviteFor(null);
        setLinkView({ link: result.link ?? null, assignmentLabel: String(request.assignmentLabel ?? ""), productName: product ? nameOf(product) : "" });
        if (!reloaded) setNotice({ tone: "error", message: "一覧を再読込してください。" });
      } else {
        setNotice({ tone: "success", message: `${request.action === "revokeInvitation" ? "招待を取り消しました" : "担当を解除しました"}${reloadHint}` });
      }
    } catch {
      // The result is not known: the same request (and `commandId`) is sent again by 結果を確認.
      setInviteFor(null); setUnknown(true);
      setNotice({ tone: "error", message: "保存結果を確認できません。" });
    } finally { setBusy(false); }
  };

  const locked = busy || pendingRequest !== null;
  const confirmItem = confirm;

  return (
    <HostPageBody>
      <div className="md:max-w-[720px]">
        <PageHead title="運営者" />
        <div className={notice || unknown ? "mb-3.5 flex flex-wrap items-center gap-x-3 gap-y-1" : "sr-only"}>
          {/* One flex item, so the empty status line does not push the words in by the gap. */}
          <div className="min-w-0"><HostNoticeLine notice={notice} /></div>
          {pendingRequest && unknown ? <button type="button" disabled={busy} onClick={() => void post(pendingRequest)} className={`${consoleButtonClass("secondary", "sm")} disabled:opacity-50`}>結果を確認</button> : null}
        </div>
        <div className="flex flex-col gap-3.5">
          {groups.map(({ product, invitable }) => {
            const grants = activeGrants.filter((item) => keyOf(item) === keyOf(product));
            const invitations = pendingInvitations.filter((item) => keyOf(item) === keyOf(product));
            const empty = grants.length + invitations.length === 0;
            const headId = `operators-${product.providerId}-${product.productId}`;
            return (
              <section key={keyOf(product)} aria-labelledby={headId} className={HOST_SURFACE}>
                <div className={`flex items-center justify-between gap-3 ${empty ? "px-4 py-3 md:px-5" : "px-4 pt-4 pb-2 md:px-5"}`}>
                  <SectionTitle id={headId}>{nameOf(product)}</SectionTitle>
                  {invitable ? (
                    <button type="button" disabled={locked} onClick={() => { setNotice(null); setInviteFor(product); }} className={`${consoleButtonClass("secondary", "sm")} disabled:opacity-50`}>
                      <HostIcon name="plus" className="size-3.5" />
                      招待
                    </button>
                  ) : null}
                </div>
                {empty ? null : (
                  <ul className="divide-y divide-line">
                    {grants.map((item) => (
                      <li key={`${item.nihoUserId}`} className={`${LIST_ROW} flex-wrap`}>
                        <InitialAvatar name={item.assignmentLabel} />
                        <div className="min-w-0 flex-[1_1_90px]">
                          <p className={LIST_ROW_TITLE}>{item.assignmentLabel}</p>
                          {item.expiresAtUtc ? <p className={LIST_ROW_DETAIL}>{untilText(item.expiresAtUtc)}</p> : null}
                        </div>
                        <div className="ml-auto flex items-center gap-2">
                          {isPast(item.expiresAtUtc, now) ? <StatusPill status={EXPIRED} /> : null}
                          <button type="button" disabled={locked} onClick={() => setConfirm({ kind: "grant", item })} className={`${consoleButtonClass("ghost", "sm")} disabled:opacity-50`}>解除</button>
                        </div>
                      </li>
                    ))}
                    {invitations.map((item) => {
                      const expired = isPast(item.expiresAtUtc, now);
                      return (
                        <li key={item.id} className={`${LIST_ROW} flex-wrap`}>
                          <InitialAvatar name={item.assignmentLabel} />
                          <div className="min-w-0 flex-[1_1_90px]">
                            <p className={LIST_ROW_TITLE}>{item.assignmentLabel}</p>
                            {expired ? null : <p className={LIST_ROW_DETAIL}>{untilText(item.expiresAtUtc)}</p>}
                          </div>
                          <div className="ml-auto flex items-center gap-2">
                            <StatusPill status={expired ? EXPIRED : INVITED} />
                            <button type="button" disabled={locked} onClick={() => setConfirm({ kind: "invitation", item })} className={`${consoleButtonClass("ghost", "sm")} disabled:opacity-50`}>取り消す</button>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>
            );
          })}
        </div>
      </div>
      {inviteFor ? <InviteFormDialog key={`${inviteFor.providerId}:${inviteFor.productId}`} productName={nameOf(inviteFor)} busy={busy} onClose={() => setInviteFor(null)} onSubmit={(assignmentLabel) => void post({ action: "createInvitation", providerId: inviteFor.providerId, productId: inviteFor.productId, assignmentLabel })} /> : null}
      {linkView ? <InviteLinkDialog view={linkView} onClose={() => setLinkView(null)} /> : null}
      {confirmItem ? <RevokeDialog confirm={confirmItem} nameOf={nameOf} onConfirm={() => void post(confirmItem.kind === "invitation"
        ? { action: "revokeInvitation", invitationId: confirmItem.item.id, expectedRevision: confirmItem.item.revision }
        : { action: "revokeGrant", providerId: confirmItem.item.providerId, productId: confirmItem.item.productId, nihoUserId: confirmItem.item.nihoUserId, expectedVersion: confirmItem.item.version })} onClose={() => setConfirm(null)} /> : null}
    </HostPageBody>
  );
}

function RevokeDialog({ confirm, nameOf, onConfirm, onClose }: { confirm: Confirm; nameOf: (item: { productTitle: string; sellerDisplayName: string }) => string; onConfirm: () => void; onClose: () => void }) {
  const stay = useRef<HTMLButtonElement>(null);
  const invitation = confirm.kind === "invitation";
  return (
    <HostConfirmDialog
      title={invitation ? "招待を取り消しますか？" : "担当を解除しますか？"}
      description={`${confirm.item.assignmentLabel} · ${nameOf(confirm.item)}`}
      focusRef={stay}
      stayRef={stay}
      confirm={<button type="submit" className={DANGER_BUTTON}>{invitation ? "取り消す" : "解除する"}</button>}
      onConfirm={onConfirm}
      onClose={onClose}
    />
  );
}
