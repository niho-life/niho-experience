import Link from "next/link";
import { HOST_START_PATH } from "@/lib/host/routes";
import type { AddHostState } from "@/lib/host/providers";
import { hostButtonClass } from "./host-ui";

/**
 * 「ホストを追加」(#709): under 「所属している提供者」. Nothing without EXPERIENCE_HOST_SELF_REGISTRATION_ENABLED; at the limit of
 * owned hosts the button gives way to the limit, so nobody walks through the form to be refused at its end.
 */
export function HostAddHost({ state, limit }: { state: AddHostState; limit: number }) {
  if (state === "hidden") return null;
  return (
    <div className="border-t border-line px-4 py-3 md:px-5">
      {state === "limit"
        ? <p className="text-[0.875rem] text-ink-soft">ホストは {limit} つまでです。</p>
        : <Link href={HOST_START_PATH} className={hostButtonClass("secondary")}>ホストを追加</Link>}
    </div>
  );
}
