import { HOST_SURFACE } from "@/components/host/host-ui";
import type { AdminHttpSessionLoad } from "@/lib/admin/server";

const formatJst = (time: number) => new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", dateStyle: "medium", timeStyle: "short" }).format(time);

/**
 * What /admin/bookings and /admin/notifications show while NIHO's read API is off: who is signed in and until when. With
 * the Google login (ADR 0003) NIHO's booking support and notifications are not used at all.
 */
export function AdminSignedInNotice({ load, nihoTitle }: { load: Extract<AdminHttpSessionLoad, { status: "ok" }>; nihoTitle: string }) {
  const niho = load.kind === "niho";
  const actorName = load.actor.displayName?.trim() || (niho ? "NIHO 管理者" : "管理者");
  const expires = formatJst(niho ? load.verified.connection.expiresAt : load.session.absoluteExpiresAt);
  return (
    <div className="mx-auto max-w-2xl px-4 py-12">
      <section className={`${HOST_SURFACE} p-6`}>
        <p className="text-xs font-extrabold tracking-[0.08em] text-moss">{niho ? "NIHO 接続済み" : "Google でログイン済み"}</p>
        <h1 className="mt-2 font-display text-2xl font-medium">{niho ? nihoTitle : "NIHO の予約支援は使いません"}</h1>
        <dl className="mt-5 grid gap-3 rounded-xl bg-sand/55 p-4 sm:grid-cols-2">
          <div><dt className="text-xs font-extrabold text-muted">確認済み管理者</dt><dd className="mt-1 break-all font-bold">{actorName}</dd></div>
          <div><dt className="text-xs font-extrabold text-muted">{niho ? "接続期限" : "ログインの期限"}</dt><dd className="mt-1 font-bold">{expires} JST</dd></div>
        </dl>
        <p className="mt-5 text-ink-soft">
          {niho
            ? "管理者認証だけが接続されています。予約・通知の読取flagはOFFです。NIHO側の配備と受入後に有効化します。"
            : "このログインでは NIHO の予約支援・通知・運営の API を使いません。予約・掲載先・体験の停止は、メニューから開いてください。"}
        </p>
      </section>
    </div>
  );
}
