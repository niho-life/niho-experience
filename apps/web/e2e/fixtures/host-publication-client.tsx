import React from "react";
import { createRoot } from "react-dom/client";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { HostPublicationWorkspace } from "../../src/components/host/HostPublicationWorkspace";

Object.assign(globalThis, { React });
const router = { back() {}, forward() {}, refresh() {}, hmrRefresh() {}, push() {}, replace() {}, prefetch() {} };

window.mountHostPublication = (adminDraftCreate) => createRoot(document.getElementById("root")!).render(
  <AppRouterContext.Provider value={router}>
    <HostPublicationWorkspace apiBase="/synthetic/products"
      {...(adminDraftCreate ? { create: true, mode: "admin-draft" } : { productId: "synthetic-product" })} />
  </AppRouterContext.Provider>,
);
