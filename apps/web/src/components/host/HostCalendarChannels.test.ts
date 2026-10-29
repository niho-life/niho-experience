import { describe, expect, it } from "vitest";
import { channelSummary, type HostChannelState } from "./HostCalendarChannels";

describe("host calendar channel labels", () => {
  it("uses the authority label rather than an old observed value", () => {
    const pending = { kind: "ready", channels: [{ occurrenceId: "occurrence-a", site: "Synthetic OTA", desired: "CLOSED", label: "PENDING" }] } satisfies HostChannelState;
    expect(channelSummary(pending, "occurrence-a")).toEqual({ label: "反映待ち", tone: "wait" });
  });

  it("does not turn missing, unreadable, or disabled data into reflected success", () => {
    expect(channelSummary({ kind: "ready", channels: [] }, "occurrence-a")).toEqual({ label: "未確認", tone: "draft" });
    expect(channelSummary({ kind: "error" }, "occurrence-a")).toEqual({ label: "要確認", tone: "wait" });
    expect(channelSummary({ kind: "disabled" }, "occurrence-a")).toBeNull();
  });

  it("shows reflected only when every returned label is SYNCED", () => {
    const synced = { kind: "ready", channels: [
      { occurrenceId: "occurrence-a", site: "Synthetic A", desired: "OPEN", label: "SYNCED" },
      { occurrenceId: "occurrence-a", site: "Synthetic B", desired: "OPEN", label: "SYNCED" },
    ] } satisfies HostChannelState;
    expect(channelSummary(synced, "occurrence-a")).toEqual({ label: "反映済み", tone: "ok" });
  });
});
