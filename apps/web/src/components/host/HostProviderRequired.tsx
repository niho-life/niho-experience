import { PROVIDER_REQUIRED_MESSAGE, PROVIDER_SWITCH_LABEL, PROVIDER_SWITCH_PATH } from "@/lib/host/api-path";

/**
 * 「ホストを選んでください」(#709): the host API answered 409 PROVIDER_REQUIRED, or the address names a host the account does
 * not have, so no host is on screen. The way out is the host list in 「あなたのアカウント」, not a generic error.
 */
export function HostProviderRequiredLink() {
  return <a href={PROVIDER_SWITCH_PATH} className="ml-1 font-bold underline underline-offset-4">{PROVIDER_SWITCH_LABEL}</a>;
}

/** A screen's error line: its text, plus the way to choose a host when the text is the 「ホストを選んでください」 one. */
export function HostErrorMessage({ text }: { text: string }) {
  return <>{text}{text === PROVIDER_REQUIRED_MESSAGE ? <HostProviderRequiredLink /> : null}</>;
}

/** The whole-screen version, in place of a form or a workspace that cannot know which host it is for. */
export function HostProviderRequiredNotice() {
  return <p role="alert" className="rounded-xl bg-danger-pale p-3 text-danger"><HostErrorMessage text={PROVIDER_REQUIRED_MESSAGE} /></p>;
}
