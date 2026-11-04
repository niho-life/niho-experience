import { describe, expect, it } from "vitest";
import type { ExperienceOffer } from "@niho-experience/api-client";
import { answersForCheckout } from "./site-booking-answers";

const questions: ExperienceOffer["bookingQuestions"] = [
  { id: "meal", prompt: "食事", description: null, inputType: "SINGLE_SELECT", required: true, options: [{ id: "vegetarian", label: "菜食" }] },
  { id: "access", prompt: "配慮", description: null, inputType: "MULTI_SELECT", required: false, options: [{ id: "step-free", label: "段差なし" }] },
  { id: "note", prompt: "補足", description: null, inputType: "SHORT_TEXT", required: false, options: [] },
];

describe("answersForCheckout", () => {
  it("sends selection IDs as optionIds and keeps free text trimmed", () => {
    expect(answersForCheckout(questions, { meal: "vegetarian", access: ["step-free"], note: "  synthetic note  " })).toEqual([
      { questionId: "meal", optionIds: ["vegetarian"] },
      { questionId: "access", optionIds: ["step-free"] },
      { questionId: "note", text: "synthetic note" },
    ]);
  });

  it("omits empty optional answers", () => {
    expect(answersForCheckout(questions, { meal: "", access: [], note: "  " })).toEqual([]);
  });
});
