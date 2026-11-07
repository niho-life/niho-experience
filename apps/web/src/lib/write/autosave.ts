import { WriteApiError } from "./api";

export type AutosavePhase = "saved" | "editing" | "saving" | "failed" | "signed-out" | "conflict";
export type AutosaveState = {
  readonly phase: AutosavePhase;
  readonly dirty: boolean;
  readonly revision: number;
  readonly savedAt?: Date;
};

type SaveResult = { readonly revision: number };

/** A latest-value queue: at most one PATCH is in flight and a newer edit always follows it. */
export class WriteAutosaveQueue<T> {
  #latest: T;
  #generation = 0;
  #savedGeneration = 0;
  #revision: number;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #inflight: Promise<boolean> | null = null;
  #frozen = false;
  #state: AutosaveState;

  constructor(
    initial: T,
    revision: number,
    private readonly save: (draft: T, expectedRevision: number) => Promise<SaveResult>,
    private readonly notify: (state: AutosaveState) => void,
    private readonly debounceMs = 900,
  ) {
    this.#latest = initial;
    this.#revision = revision;
    this.#state = { phase: "saved", dirty: false, revision };
  }

  get state() { return this.#state; }
  get latest() { return this.#latest; }
  get revision() { return this.#revision; }
  get frozen() { return this.#frozen; }

  update(draft: T) {
    this.#latest = draft;
    this.#generation++;
    if (this.#frozen) return;
    this.#set({ phase: "editing", dirty: true, revision: this.#revision });
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => { void this.flush(); }, this.debounceMs);
  }

  adoptRevision(revision: number) {
    if (!Number.isSafeInteger(revision) || revision < this.#revision) return;
    this.#revision = revision;
    this.#set({ ...this.#state, revision });
  }

  async flush(): Promise<boolean> {
    if (this.#timer) { clearTimeout(this.#timer); this.#timer = null; }
    if (this.#frozen) return false;
    if (this.#inflight) {
      await this.#inflight;
      if (this.#frozen) return false;
      if (this.#savedGeneration < this.#generation) return this.flush();
      return true;
    }
    if (this.#savedGeneration >= this.#generation) return true;
    this.#inflight = this.#run();
    let result: boolean;
    try { result = await this.#inflight; }
    finally { this.#inflight = null; }
    if (result && this.#savedGeneration < this.#generation) return this.flush();
    return result;
  }

  async retry(): Promise<boolean> {
    if (this.#state.phase === "conflict") return false;
    this.#frozen = false;
    return this.flush();
  }

  freezeConflict() {
    if (this.#timer) { clearTimeout(this.#timer); this.#timer = null; }
    this.#frozen = true;
    this.#set({ phase: "conflict", dirty: true, revision: this.#revision });
  }

  dispose() { if (this.#timer) clearTimeout(this.#timer); }

  async #run(): Promise<boolean> {
    const generation = this.#generation;
    const draft = this.#latest;
    this.#set({ phase: "saving", dirty: true, revision: this.#revision });
    try {
      const result = await this.save(draft, this.#revision);
      this.#revision = result.revision;
      this.#savedGeneration = generation;
      const caughtUp = this.#savedGeneration >= this.#generation;
      this.#set({ phase: caughtUp ? "saved" : "editing", dirty: !caughtUp, revision: this.#revision, savedAt: new Date() });
      return true;
    } catch (error) {
      const phase = error instanceof WriteApiError && error.kind === "unauthenticated"
        ? "signed-out"
        : error instanceof WriteApiError && error.kind === "conflict" ? "conflict" : "failed";
      this.#frozen = phase === "conflict" || phase === "signed-out";
      this.#set({ phase, dirty: true, revision: this.#revision });
      return false;
    }
  }

  #set(state: AutosaveState) {
    this.#state = state;
    this.notify(state);
  }
}
