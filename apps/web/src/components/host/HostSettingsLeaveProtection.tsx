"use client";

import { HostLeaveDialog, useHostLeaveGuard, type HostLeaveMode } from "./HostLeaveGuard";

/** Mounted only for an editable settings section with pending changes or a save in flight. */
export function HostSettingsLeaveProtection({ mode }: { mode: Exclude<HostLeaveMode, null> }) {
  const guard = useHostLeaveGuard(mode);
  return guard.asking ? <HostLeaveDialog mode={mode} requestKey={guard.requestKey} onStay={guard.stay} onLeave={guard.leave} /> : null;
}
