(() => {
  if (window.__nihoAdminHistoryGuardInstalled) return;
  window.__nihoAdminHistoryGuardInstalled = true;

  let restoringTraversal = null;

  function currentEntryIndex() {
    const index = window.navigation?.currentEntry?.index;
    return Number.isInteger(index) && index >= 0 ? index : null;
  }

  // Installed before the App Router so a dirty support-case editor is not unmounted
  // before its in-page confirmation can restore the entry that owns the draft.
  window.addEventListener("popstate", (event) => {
    const targetIndex = currentEntryIndex();

    if (restoringTraversal) {
      const restore = restoringTraversal;
      restoringTraversal = null;
      if (targetIndex === restore.currentIndex && window.location.href === restore.currentHref && restore.guard.blocking) {
        event.stopImmediatePropagation();
        restore.guard.onHistoryLeave(restore.delta);
        return;
      }
    }

    const guard = window.__nihoAdminHistoryGuard;
    if (!guard?.blocking || guard.leaving || !guard.current || typeof guard.onHistoryLeave !== "function") return;
    const current = guard.current;
    const currentUrl = new URL(current.href);
    const targetUrl = new URL(window.location.href);
    if (targetUrl.pathname === currentUrl.pathname && targetUrl.search === currentUrl.search) return;

    event.stopImmediatePropagation();
    if (current.index !== null && targetIndex !== null && current.index !== targetIndex) {
      restoringTraversal = {
        guard,
        currentIndex: current.index,
        currentHref: current.href,
        delta: targetIndex - current.index,
      };
      window.history.go(current.index - targetIndex);
      return;
    }

    // Legacy fallback only: do not grow history when the Navigation API exposes indices.
    window.history.pushState(current.state, "", current.href);
    guard.onHistoryLeave(-1);
  }, true);
})();
