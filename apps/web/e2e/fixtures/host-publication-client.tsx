import React from "react";
import { createRoot } from "react-dom/client";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { HostPublicationWorkspace } from "../../src/components/host/HostPublicationWorkspace";

Object.assign(globalThis, { React });
const router = { back() {}, forward() {}, refresh() {}, hmrRefresh() {}, push() {}, replace() {}, prefetch() {} };

// `host` mounts the host's list ("list") or its list with the 体験を作成 dialog open ("create", as /host/experiences/new does).
window.mountHostPublication = (adminDraftCreate, host) => createRoot(document.getElementById("root")!).render(
  <AppRouterContext.Provider value={router}>
    <HostPublicationWorkspace apiBase="/synthetic/products"
      {...(adminDraftCreate ? { create: true, mode: "admin-draft" } : host === "create" ? { create: true } : host === "list" ? {} : { productId: "synthetic-product" })} />
  </AppRouterContext.Provider>,
);
