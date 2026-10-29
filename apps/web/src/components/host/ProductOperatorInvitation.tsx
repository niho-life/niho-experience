"use client";

import { useEffect, useState } from "react";
import { HostLoginLink } from "./HostAppWindow";
import { hostButtonClass, HOST_SURFACE } from "./host-ui";

declare global { interface Window { __nihoOperatorInvitationSecret?: string } }

export function ProductOperatorInvitation({ invitationId, prepared, loginHref, detail }: {
  invitationId: string;
  prepared: boolean;
  loginHref: string | null;
  detail: { productTitle: string; sellerDisplayName: string; assignmentLabel: string } | null;
}) {
  const [status, setStatus] = useState(prepared ? (loginHref || detail ? "ready" : "invalid") : "preparing");
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (prepared) return;
    const secret = window.__nihoOperatorInvitationSecret;
    delete window.__nihoOperatorInvitationSecret;
    if (!secret) { queueMicrotask(() => setStatus("invalid")); return; }
    void fetch(`/host/invitations/${invitationId}/prepare`, {
      method: "POST", credentials: "same-origin", cache: "no-store", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: secret }),
    }).then((response) => {
      if (!response.ok) throw new Error("invalid");
      location.replace(`/host/invitations/${invitationId}`);
    }).catch(() => setStatus("invalid"));
  }, [invitationId, prepared]);

  const accept = async () => {
    if (saving) return;
    setSaving(true); setStatus("accepting");
    try {
      const response = await fetch(`/host/invitations/${invitationId}/accept`, { method: "POST", credentials: "same-origin", cache: "no-store", headers: { "content-type": "application/json" }, body: "{}" });
      const body = await response.json() as { href?: string };
      if (!response.ok || !body.href) throw new Error("accept");
      location.assign(body.href);
    } catch { setStatus("accept-error"); setSaving(false); }
  };

  return <main id="main" className="mx-auto grid min-h-dvh w-full max-w-xl place-items-center px-4 py-10">
    <section className={`${HOST_SURFACE} w-full p-5 sm:p-7`}>
      <p className="text-xs font-extrabold tracking-[0.08em] text-muted">NIHO EXPERIENCE</p>
      <h1 className="mt-2 font-display text-2xl font-medium">体験への招待</h1>
      {status === "preparing" ? <p role="status" className="mt-4 text-ink-soft">招待を確認しています…</p> : null}
      {status === "invalid" ? <p role="alert" className="mt-4 rounded-xl bg-warn-pale p-3 text-warn">この招待リンクは無効か、期限が切れています。管理者へ新しいリンクを依頼してください。</p> : null}
      {prepared && loginHref ? <><p className="mt-4 text-ink-soft">参加するNIHOアカウントでログインしてください。</p><HostLoginLink href={loginHref} className={`${hostButtonClass("primary")} mt-6 w-full justify-center`}>NIHOでログイン</HostLoginLink></> : null}
      {detail ? <div className="mt-5 space-y-4"><div className="rounded-xl bg-sand p-4"><p className="text-xs font-bold text-muted">担当する体験</p><p className="mt-1 font-extrabold">{detail.productTitle}</p><p className="text-sm text-ink-soft">{detail.sellerDisplayName}</p><p className="mt-2 text-sm">担当名: {detail.assignmentLabel}</p></div><p className="text-sm text-ink-soft">この体験のカレンダーを管理します。</p><button type="button" disabled={saving} onClick={() => void accept()} className={`${hostButtonClass("primary")} w-full justify-center disabled:opacity-50`}>{saving ? "参加しています…" : "参加する"}</button></div> : null}
      {status === "accept-error" ? <p role="alert" className="mt-4 rounded-xl bg-warn-pale p-3 text-warn">参加を完了できませんでした。招待の状態を確認して、もう一度お試しください。</p> : null}
    </section>
  </main>;
}
