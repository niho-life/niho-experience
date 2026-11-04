import { describe, expect, it, vi } from "vitest";
import {
  beginFinancialExecution,
  beginFinancialPreview,
  beginContactOperation,
  claimFinancialOperation,
  contactCommand,
  finishFinancialPreview,
  markContactUnknown,
  markFinancialUnknown,
  releaseContactOperation,
  releaseFinancialOperation,
  type SiteBookingOperationLock,
} from "./site-booking-operation-lock";

describe("Admin site booking operation lock", () => {
  it("treats different panels for the same booking as different owners and permits only the owner's same-command retry", () => {
    let lock: SiteBookingOperationLock | null = null;
    const first = beginContactOperation(lock, "panel-refund-a", "command-a");
    expect(first.accepted).toBe(true);
    lock = first.lock;
    lock = markContactUnknown(lock, "panel-refund-a", "command-a").lock;

    expect(beginContactOperation(lock, "panel-refund-b", "command-b")).toMatchObject({ accepted: false, lock });
    expect(beginContactOperation(lock, "panel-refund-a", "command-new")).toMatchObject({ accepted: false, lock });
    expect(beginContactOperation(lock, "panel-refund-a", "command-a")).toMatchObject({ accepted: true, lock: { phase: "IN_FLIGHT", commandId: "command-a" } });
    expect(releaseContactOperation(lock, "panel-refund-b", "command-a")).toMatchObject({ accepted: false, lock });
  });

  it("blocks contact after a financial form opens and while its command is pending", () => {
    let lock = claimFinancialOperation(null, "financial-form").lock;
    expect(beginContactOperation(lock, "contact-panel", "contact-command").accepted).toBe(false);
    const pending = beginFinancialExecution(lock, "financial-form");
    expect(pending.accepted).toBe(true);
    lock = pending.lock;
    expect(beginContactOperation(lock, "contact-panel", "contact-command").accepted).toBe(false);
    expect(releaseFinancialOperation(lock, "another-financial-owner").accepted).toBe(false);
  });

  it("blocks financial form/preview/send ownership while a contact result is unknown", () => {
    let lock = beginContactOperation(null, "contact-panel", "contact-command").lock;
    lock = markContactUnknown(lock, "contact-panel", "contact-command").lock;
    expect(claimFinancialOperation(lock, "financial-form").accepted).toBe(false);
    expect(beginFinancialPreview(lock, "financial-form").accepted).toBe(false);
    expect(beginFinancialExecution(lock, "financial-form").accepted).toBe(false);
    expect(releaseFinancialOperation(lock, "financial-form").accepted).toBe(false);
  });

  it("fixes the command before awaiting, rejects a double click in flight, and reuses the same payload after an unknown result", () => {
    const createCommandId = vi.fn(() => "same-command");
    let saved = contactCommand(null, { publicBookingId: "booking-a", message: "Synthetic message" }, createCommandId);
    let lock = beginContactOperation(null, "contact-panel", saved.commandId).lock;
    const secondClick = contactCommand(saved, { publicBookingId: "booking-a", message: "Changed message" }, createCommandId);
    expect(secondClick).toBe(saved);
    expect(createCommandId).toHaveBeenCalledTimes(1);
    expect(beginContactOperation(lock, "contact-panel", secondClick.commandId).accepted).toBe(false);

    lock = markContactUnknown(lock, "contact-panel", saved.commandId).lock;
    const retry = contactCommand(saved, { publicBookingId: "booking-a", message: "Changed message" }, createCommandId);
    expect(retry).toBe(saved);
    expect(beginContactOperation(lock, "contact-panel", retry.commandId).accepted).toBe(true);
    saved = retry;
    expect(saved.message).toBe("Synthetic message");
  });

  it("releases contact only for its exact owner and command", () => {
    const lock = markContactUnknown(beginContactOperation(null, "panel-a", "command-a").lock, "panel-a", "command-a").lock;
    expect(releaseContactOperation(lock, "panel-a", "command-b")).toMatchObject({ accepted: false, lock });
    expect(releaseContactOperation(lock, "panel-b", "command-a")).toMatchObject({ accepted: false, lock });
    expect(releaseContactOperation(lock, "panel-a", "command-a")).toEqual({ accepted: true, lock: null });
  });

  it("rejects duplicate financial preview/execution clicks but permits the same pending command after an unknown result", () => {
    let lock = claimFinancialOperation(null, "financial-form").lock;
    const preview = beginFinancialPreview(lock, "financial-form");
    expect(preview.accepted).toBe(true);
    lock = preview.lock;
    expect(beginFinancialPreview(lock, "financial-form").accepted).toBe(false);

    const previewFinished = finishFinancialPreview(lock, "financial-form");
    expect(previewFinished.accepted).toBe(true);
    lock = previewFinished.lock;
    const execution = beginFinancialExecution(lock, "financial-form");
    expect(execution.accepted).toBe(true);
    lock = execution.lock;
    expect(beginFinancialExecution(lock, "financial-form").accepted).toBe(false);
    lock = markFinancialUnknown(lock, "financial-form").lock;
    expect(beginFinancialExecution(lock, "financial-form").accepted).toBe(true);
  });
});
