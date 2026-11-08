export type TeamRequestKind = "list" | "resolve" | "command";
export type TeamRequestToken = { readonly kind: TeamRequestKind; readonly scope: string; readonly sequence: number };

/** Scope/sequence gate shared by the native panel's list, lookup and mutation requests. */
export class HostTeamAsyncGate {
  #scope: string | null = null;
  #sequence: Record<TeamRequestKind, number> = { list: 0, resolve: 0, command: 0 };

  activate(scope: string): void { this.#scope = scope; this.invalidateAll(); }
  deactivate(): void { this.#scope = null; this.invalidateAll(); }
  begin(kind: TeamRequestKind): TeamRequestToken {
    const scope = this.#scope;
    if (scope === null) throw new Error("Host team request scope is inactive.");
    if (kind === "command") {
      this.invalidate("list");
      this.invalidate("resolve");
    }
    return { kind, scope, sequence: ++this.#sequence[kind] };
  }
  invalidate(kind: TeamRequestKind): void { this.#sequence[kind] += 1; }
  invalidateAll(): void { this.invalidate("list"); this.invalidate("resolve"); this.invalidate("command"); }
  active(scope: string): boolean { return this.#scope === scope; }
  current(token: TeamRequestToken): boolean {
    return this.#scope === token.scope && this.#sequence[token.kind] === token.sequence;
  }
}
