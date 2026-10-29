import { EDITOR_LOGIN_PATH } from "@/lib/editor/routes";
import { requireEditorConsole } from "@/lib/editor/server";

export default function EditorAuthErrorPage() {
  requireEditorConsole();
  return (
    <main id="main" className="grid min-h-dvh place-items-center px-4 py-10">
      <section role="alert" className="w-full max-w-lg rounded-3xl border border-line bg-white p-6 shadow-sm md:p-8">
        <p className="text-xs font-extrabold tracking-[0.08em] text-moss">NIHO EXPERIENCE</p>
        <h1 className="mt-2 font-display text-2xl font-medium">We couldn&apos;t complete the connection</h1>
        <p className="mt-3 text-ink-soft">Check that your NIHO account is active, then try connecting again.</p>
        <a href={EDITOR_LOGIN_PATH} className="mt-6 inline-flex min-h-12 w-full items-center justify-center rounded-full bg-leaf px-6 font-extrabold hover:bg-leaf-hover">Try again</a>
      </section>
    </main>
  );
}
