import Link from "next/link";
import { EDITOR_LOGIN_PATH, EDITOR_LOGOUT_PATH } from "@/lib/editor/routes";
import { loadEditorSession, requireEditorConsole } from "@/lib/editor/server";

export default async function EditorGuidesPlaceholderPage() {
  requireEditorConsole();
  const load = await loadEditorSession();
  const signedIn = load.status === "ok";

  return (
    <main id="main" className="grid min-h-dvh place-items-center px-4 py-10">
      <section className="w-full max-w-lg rounded-3xl border border-line bg-white p-6 shadow-sm md:p-8">
        <p className="text-xs font-extrabold tracking-[0.08em] text-moss">NIHO EXPERIENCE</p>
        <h1 className="mt-2 font-display text-2xl font-medium">Guide editor</h1>
        {signedIn ? (
          <>
            <p className="mt-3 text-ink-soft">Your NIHO account is connected. Guide editing will be added in the next stage.</p>
            <form method="post" action={EDITOR_LOGOUT_PATH} className="mt-6">
              <button type="submit" className="inline-flex min-h-12 w-full items-center justify-center rounded-full border border-line-strong px-6 font-extrabold hover:bg-sand">Sign out</button>
            </form>
          </>
        ) : (
          <>
            <p role={load.status === "error" ? "alert" : undefined} className="mt-3 text-ink-soft">
              {load.status === "error" ? "We couldn't verify your NIHO connection. Try again shortly." : "Connect an active NIHO account to continue."}
            </p>
            <Link href={EDITOR_LOGIN_PATH} className="mt-6 inline-flex min-h-12 w-full items-center justify-center rounded-full bg-leaf px-6 font-extrabold hover:bg-leaf-hover">Connect with NIHO</Link>
          </>
        )}
      </section>
    </main>
  );
}
