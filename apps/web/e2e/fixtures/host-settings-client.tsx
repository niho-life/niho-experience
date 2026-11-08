import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { HostMembershipGuard } from "../../src/components/host/HostMembershipGuard";
import { HostOperatingTeamPanel } from "../../src/components/host/HostOperatingTeamPanel";

Object.assign(globalThis, { React });

let root: Root | undefined;
const mount = (element: React.ReactNode) => {
  root ??= createRoot(document.getElementById("root")!);
  root.render(element);
};

window.mountHostGuard = (fingerprint) => mount(
  <React.StrictMode>
    <HostMembershipGuard key={fingerprint} initialFingerprint={fingerprint}>
      <div data-testid="private">Synthetic private view</div>
    </HostMembershipGuard>
  </React.StrictMode>,
);
window.mountHostTeam = (providerId) => mount(<HostOperatingTeamPanel providerId={providerId} role="OWNER" mode="native" />);
