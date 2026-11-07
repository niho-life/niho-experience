import { describe, expect, it, vi } from "vitest";
import { WriteApiError } from "./api";
import { WriteAutosaveQueue } from "./autosave";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe("WriteAutosaveQueue", () => {
  it("serializes an in-flight save and immediately follows it with the latest input and returned revision", async () => {
    const first = deferred<{ revision: number }>();
    const second = deferred<{ revision: number }>();
    const save = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const states: string[] = [];
    const queue = new WriteAutosaveQueue({ title: "initial" }, 4, save, (state) => states.push(state.phase), 60_000);

    queue.update({ title: "first" });
    const flushed = queue.flush();
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save).toHaveBeenNthCalledWith(1, { title: "first" }, 4);
    queue.update({ title: "last sentence" });
    first.resolve({ revision: 5 });
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    expect(save).toHaveBeenNthCalledWith(2, { title: "last sentence" }, 5);
    second.resolve({ revision: 6 });

    await expect(flushed).resolves.toBe(true);
    expect(queue.state).toMatchObject({ phase: "saved", dirty: false, revision: 6 });
    expect(states).toContain("saving");
  });

  it("keeps input dirty on 401 and retries the same latest value only after an explicit relogin retry", async () => {
    const save = vi.fn()
      .mockRejectedValueOnce(new WriteApiError("unauthenticated", 401))
      .mockResolvedValueOnce({ revision: 3 });
    const queue = new WriteAutosaveQueue<string>("unsent text", 2, save, () => undefined, 60_000);
    queue.update("kept in memory");

    await expect(queue.flush()).resolves.toBe(false);
    expect(queue.state).toMatchObject({ phase: "signed-out", dirty: true, revision: 2 });
    expect(queue.latest).toBe("kept in memory");
    await expect(queue.retry()).resolves.toBe(true);
    expect(save).toHaveBeenLastCalledWith("kept in memory", 2);
    expect(queue.state).toMatchObject({ phase: "saved", dirty: false, revision: 3 });
  });

  it("freezes after 409 and never replays a stale revision even when more local input arrives", async () => {
    const save = vi.fn().mockRejectedValue(new WriteApiError("conflict", 409));
    const queue = new WriteAutosaveQueue<string>("initial", 8, save, () => undefined, 60_000);
    queue.update("local A");
    await expect(queue.flush()).resolves.toBe(false);
    queue.update("local B");

    await expect(queue.flush()).resolves.toBe(false);
    await expect(queue.retry()).resolves.toBe(false);
    expect(queue.latest).toBe("local B");
    expect(queue.state).toMatchObject({ phase: "conflict", dirty: true, revision: 8 });
    expect(save).toHaveBeenCalledTimes(1);
  });
});
