import { EXPERIENCE_CONDITION_KINDS } from "@niho-experience/api-client";
import { describe, expect, it } from "vitest";
import { CONDITION_KINDS, CONDITION_LABELS, conditionDraft, conditionSummary, NO_CONDITIONS, setConditionKinds, withConditionFromDraft, withoutCondition } from "./conditions";
import { MOCK_KITCHEN_EXPERIENCES } from "./mock/experiences";

const DINNER = MOCK_KITCHEN_EXPERIENCES.find((experience) => experience.id === "community-dinner")!.conditions;

describe("参加の条件 (#110)", () => {
  it("lists the traveler side's kinds, each with its Japanese name", () => {
    expect(CONDITION_KINDS).toEqual(EXPERIENCE_CONDITION_KINDS);
    expect(CONDITION_KINDS.map((kind) => CONDITION_LABELS[kind])).toEqual(["年齢", "体の負担", "ホストの言語", "食べもの", "段差・車いす", "雨の日"]);
  });

  it("sums each kind up in one line, and says 未設定 for a kind not set", () => {
    expect(CONDITION_KINDS.map((kind) => conditionSummary(DINNER, kind))).toEqual([
      "年齢の指定なし · 子どもは大人と一緒",
      "いすに座る（約 60 分） · ほとんど歩かない",
      "日本語 · 日常会話の英語",
      "食事あり · ベジタリアンに対応",
      "段差あり・車いす不可",
      "雨でも開催（屋内）",
    ]);
    expect(CONDITION_KINDS.map((kind) => conditionSummary(NO_CONDITIONS, kind))).toEqual(Array(6).fill("未設定"));
    expect(conditionSummary({ ...NO_CONDITIONS, AGE: { minimumAge: 10, withAdult: false, note: "" } }, "AGE")).toBe("10 歳以上");
    expect(conditionSummary({ ...NO_CONDITIONS, PHYSICAL: { seating: "NONE", seatedMinutes: null, walking: "LOTS", note: "" } }, "PHYSICAL")).toBe("座る時間なし · よく歩く");
    expect(conditionSummary({ ...NO_CONDITIONS, HOST_LANGUAGE: { japanese: false, english: "FLUENT", englishGuide: true, note: "" } }, "HOST_LANGUAGE")).toBe("流暢な英語 · 英語の案内資料あり");
    expect(conditionSummary({ ...NO_CONDITIONS, FOOD: { served: "SNACK", diets: ["VEGAN", "GLUTEN_FREE", "ALLERGY_ASK"], note: "" } }, "FOOD")).toBe("軽食あり · ヴィーガン・グルテンフリーに対応 · アレルギーは相談");
    expect(conditionSummary({ ...NO_CONDITIONS, FOOD: { served: "NONE", diets: [], note: "" } }, "FOOD")).toBe("食べものは出ません");
  });

  it("opens the dialog with the kind as it is set, or with nothing chosen", () => {
    expect(conditionDraft(DINNER, "PHYSICAL")).toMatchObject({ seating: "CHAIR", seatedMinutes: "60", walking: "LITTLE", note: "You stand for about 50 minutes while we cook." });
    expect(conditionDraft(NO_CONDITIONS, "FOOD")).toMatchObject({ served: null, diets: [], note: "" });
    expect(conditionDraft(NO_CONDITIONS, "HOST_LANGUAGE")).toMatchObject({ japanese: true, english: null });
  });

  it("takes the dialog's values back, once the choices the kind needs are made", () => {
    const age = { ...conditionDraft(NO_CONDITIONS, "AGE"), minimumAge: " 10 ", withAdult: true, note: " 10 歳から " };
    expect(withConditionFromDraft(NO_CONDITIONS, "AGE", age)?.AGE).toEqual({ minimumAge: 10, withAdult: true, note: "10 歳から" });
    expect(withConditionFromDraft(NO_CONDITIONS, "AGE", { ...age, minimumAge: "" })?.AGE?.minimumAge).toBeNull();
    const food = conditionDraft(NO_CONDITIONS, "FOOD");
    expect(withConditionFromDraft(NO_CONDITIONS, "FOOD", food)).toBeNull();
    expect(withConditionFromDraft(NO_CONDITIONS, "FOOD", { ...food, served: "MEAL", diets: ["ALLERGY_ASK", "VEGETARIAN"] })?.FOOD).toEqual({ served: "MEAL", diets: ["VEGETARIAN", "ALLERGY_ASK"], note: "" });
    const physical = { ...conditionDraft(NO_CONDITIONS, "PHYSICAL"), seating: "NONE" as const, seatedMinutes: "30", walking: "SOME" as const };
    expect(withConditionFromDraft(NO_CONDITIONS, "PHYSICAL", physical)?.PHYSICAL).toEqual({ seating: "NONE", seatedMinutes: null, walking: "SOME", note: "" });
    expect(withConditionFromDraft(NO_CONDITIONS, "PHYSICAL", { ...physical, walking: null })).toBeNull();
    expect(withConditionFromDraft(NO_CONDITIONS, "WEATHER", { ...conditionDraft(NO_CONDITIONS, "WEATHER"), rain: "LIGHT_RAIN" })?.WEATHER).toEqual({ rain: "LIGHT_RAIN", note: "" });
    expect(withConditionFromDraft(NO_CONDITIONS, "ACCESS", conditionDraft(NO_CONDITIONS, "ACCESS"))).toBeNull();
    expect(withConditionFromDraft(NO_CONDITIONS, "HOST_LANGUAGE", { ...conditionDraft(NO_CONDITIONS, "HOST_LANGUAGE"), english: "BASIC", englishGuide: true })?.HOST_LANGUAGE).toEqual({ japanese: true, english: "BASIC", englishGuide: true, note: "" });
  });

  it("goes back to 未設定, and lists what is set", () => {
    expect(setConditionKinds(DINNER)).toEqual([...EXPERIENCE_CONDITION_KINDS]);
    expect(setConditionKinds(withoutCondition(DINNER, "FOOD"))).toEqual(["AGE", "PHYSICAL", "HOST_LANGUAGE", "ACCESS", "WEATHER"]);
    expect(setConditionKinds(NO_CONDITIONS)).toEqual([]);
  });
});
