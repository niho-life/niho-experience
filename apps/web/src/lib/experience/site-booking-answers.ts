import type { CheckoutAnswer, ExperienceOffer } from "@niho-experience/api-client";

export type SiteBookingAnswers = Readonly<Record<string, string | readonly string[] | undefined>>;

/** Translate the public question controls into the public checkout answer contract. */
export function answersForCheckout(
  questions: readonly Pick<ExperienceOffer["bookingQuestions"][number], "id" | "inputType">[],
  answers: SiteBookingAnswers,
): CheckoutAnswer[] {
  return questions.flatMap((question): CheckoutAnswer[] => {
    const value = answers[question.id];
    if (question.inputType === "SINGLE_SELECT" && typeof value === "string" && value.length > 0) {
      return [{ questionId: question.id, optionIds: [value] }];
    }
    if (question.inputType === "MULTI_SELECT" && Array.isArray(value) && value.length > 0) {
      return [{ questionId: question.id, optionIds: [...value] }];
    }
    if ((question.inputType === "SHORT_TEXT" || question.inputType === "LONG_TEXT")
      && typeof value === "string" && value.trim().length > 0) {
      return [{ questionId: question.id, text: value.trim() }];
    }
    return [];
  });
}
