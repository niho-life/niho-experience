import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { EXPERIENCE_HOST_API_CONTRACT } from "../src/contract-meta.ts";
import { EXPERIENCE_HOST_ERROR_CODES, EXPERIENCE_HOST_ERROR_REASONS } from "../src/host/types.ts";
import {
  auditContractDocument,
  auditHostContractDocument,
  EXPERIENCE_CONTRACT_DOCUMENT,
  EXPERIENCE_HOST_CONTRACT_DOCUMENT,
  EXPERIENCE_HOST_FIELD_POLICY,
} from "../src/testing/index.ts";
import { generateContractTypes } from "../scripts/gen-types.ts";

type AnyRecord = Record<string, any>;

const clone = () => structuredClone(EXPERIENCE_HOST_CONTRACT_DOCUMENT) as AnyRecord;

describe("ホスト API の契約の文書", () => {
  it("ホストの規則（範囲・Bearer・印・閉じた形・禁止項目・応答は全項目必須）を満たす", () => {
    expect(auditHostContractDocument()).toEqual([]);
  });

  it("選別済み契約の sha256 が一致する", async () => {
    const body = await readFile(new URL("../contract/experience-host-api.openapi.json", import.meta.url));
    const recorded = await readFile(new URL("../contract/experience-host-api.openapi.json.sha256", import.meta.url), "utf8");
    expect(recorded.trim()).toBe(`${createHash("sha256").update(body).digest("hex")}  experience-host-api.openapi.json`);
  });

  it("版と状態が contract-meta と一致する", () => {
    const info = EXPERIENCE_HOST_CONTRACT_DOCUMENT.info as AnyRecord;
    expect(info.version).toBe(EXPERIENCE_HOST_API_CONTRACT.version);
    expect(info["x-niho-contract-status"]).toBe(EXPERIENCE_HOST_API_CONTRACT.status);
  });

  it("操作は提供者の 28 個と GET /api/auth/me だけ", () => {
    const operations = Object.entries(EXPERIENCE_HOST_CONTRACT_DOCUMENT.paths as AnyRecord).flatMap(([path, item]) =>
      Object.entries(item as AnyRecord)
        .filter(([method]) => method !== "parameters")
        .map(([method, operation]) => `${method.toUpperCase()} ${path} ${(operation as AnyRecord).operationId}`),
    );
    expect(operations.sort()).toEqual([
      "GET /api/auth/me getAuthMe",
      "GET /api/experience-providers listExperienceProviders",
      "GET /api/experience-providers/{providerId} getExperienceProvider",
      "GET /api/experience-providers/{providerId}/payments/readiness getExperienceProviderPaymentReadiness",
      "GET /api/experience-providers/{providerId}/payments/reuse-candidates listExperienceProviderPaymentReuseCandidates",
      "PATCH /api/experience-providers/{providerId} updateExperienceProvider",
      "POST /api/experience-providers registerExperienceProvider",
      "POST /api/experience-providers/{providerId}/payments/connect/resume resumeExperienceProviderPaymentConnect",
      "POST /api/experience-providers/{providerId}/payments/connect/start startExperienceProviderPaymentConnect",
      "POST /api/experience-providers/{providerId}/payments/connect/sync syncExperienceProviderPaymentConnect",
      "POST /api/experience-providers/{providerId}/payments/reuse reuseExperienceProviderPayment",
      "POST /api/experience-providers/{providerId}/submit submitExperienceProvider",
      "GET /api/experience-providers/{providerId}/meeting-point getExperienceProviderMeetingPoint",
      "PUT /api/experience-providers/{providerId}/meeting-point updateExperienceProviderMeetingPoint",
      "GET /api/experience-providers/{providerId}/pages listExperienceProviderPages",
      "POST /api/experience-providers/{providerId}/pages createExperienceProviderPage",
      "GET /api/experience-providers/{providerId}/pages/{pageId} getExperienceProviderPage",
      "PATCH /api/experience-providers/{providerId}/pages/{pageId} updateExperienceProviderPage",
      "DELETE /api/experience-providers/{providerId}/pages/{pageId} deleteExperienceProviderPage",
      "POST /api/experience-providers/{providerId}/pages/{pageId}/publish publishExperienceProviderPage",
      "POST /api/experience-providers/{providerId}/pages/{pageId}/unpublish unpublishExperienceProviderPage",
      "GET /api/experience-providers/{providerId}/pages/{pageId}/preview getExperienceProviderPagePreview",
      "GET /api/experience-providers/{providerId}/pages/{pageId}/meeting-point getExperienceProviderPageMeetingPoint",
      "PUT /api/experience-providers/{providerId}/pages/{pageId}/meeting-point updateExperienceProviderPageMeetingPoint",
      "GET /api/experience-providers/{providerId}/pages/{pageId}/experience-site-listing getExperienceProviderPageListing",
      "PUT /api/experience-providers/{providerId}/pages/{pageId}/experience-site-listing requestExperienceProviderPageListing",
      "DELETE /api/experience-providers/{providerId}/pages/{pageId}/experience-site-listing withdrawExperienceProviderPageListing",
      "POST /api/experience-providers/{providerId}/uploads/policies createExperienceProviderUploadPolicy",
      "POST /api/experience-providers/{providerId}/uploads/signed-url createExperienceProviderUploadSignedUrl",
    ].sort());
  });

  it("閉じない schema は許可リストの 2 つだけで、me の応答は ExperienceHostAuthMe", () => {
    expect(Object.keys(EXPERIENCE_HOST_FIELD_POLICY.openSchemas).sort()).toEqual(["ExperienceHostAuthMe", "ExperienceProviderUploadPolicyFields"]);
    const me = (EXPERIENCE_HOST_CONTRACT_DOCUMENT.paths as AnyRecord)["/api/auth/me"].get.responses["200"].content["application/json"].schema;
    expect(me).toEqual({ $ref: "#/components/schemas/ExperienceHostAuthMe" });
    // 写真の form の項目は名前が開いているが、値は文字列だけ
    expect((EXPERIENCE_HOST_CONTRACT_DOCUMENT.components as AnyRecord).schemas.ExperienceProviderUploadPolicyFields.additionalProperties).toEqual({ type: "string" });
  });

  it("失敗の応答はすべて閉じた ExperienceHostErrorResponse で、理由は契約の enum", () => {
    const document = EXPERIENCE_HOST_CONTRACT_DOCUMENT as AnyRecord;
    expect(document.components.schemas).not.toHaveProperty("ErrorResponse");
    const errorSchemas = Object.entries(document.paths as AnyRecord).flatMap(([, item]) =>
      Object.entries(item as AnyRecord)
        .filter(([method]) => method !== "parameters")
        .flatMap(([, operation]) => Object.entries((operation as AnyRecord).responses as AnyRecord).filter(([status]) => Number(status) >= 400)),
    ).map(([, response]) => {
      const resolved = typeof response.$ref === "string" ? document.components.responses[response.$ref.replace("#/components/responses/", "")] : response;
      return resolved.content["application/json"].schema.$ref;
    });
    expect(errorSchemas.length).toBeGreaterThan(29);
    expect(new Set(errorSchemas)).toEqual(new Set(["#/components/schemas/ExperienceHostErrorResponse"]));
    expect(EXPERIENCE_HOST_ERROR_REASONS).toEqual(document.components.schemas.ExperienceHostErrorReason.enum);
    expect(EXPERIENCE_HOST_ERROR_CODES).toEqual(document.components.schemas.ExperienceHostErrorCode.enum);
  });

  it("禁止の語の例外は理由つきで、契約にある名前だけ", () => {
    const allowed = EXPERIENCE_HOST_FIELD_POLICY.allowedPropertyNames;
    expect(Object.fromEntries(Object.entries(allowed).map(([group, { token, schemas }]) => [group, { token, names: [...new Set(Object.values(schemas).flat())].sort() }]))).toEqual({
      photoObjectKey: { token: "objectkey", names: ["coverObjectKey", "exteriorPhotoObjectKey", "objectKey", "photoObjectKey", "photoObjectKeys"] },
      meetingPointAddress: { token: "address", names: ["address"] },
    });
    for (const { reason } of Object.values(allowed)) expect(reason.length).toBeGreaterThan(20);
    // 語そのものの禁止は残す
    expect(EXPERIENCE_HOST_FIELD_POLICY.forbiddenNameTokens).toEqual(expect.arrayContaining(["objectkey", "address"]));
  });

  it("生成した型が契約と一致する（drift が無い）", async () => {
    const committed = await readFile(new URL("../src/generated/host-openapi.ts", import.meta.url), "utf8");
    expect(committed).toBe(await generateContractTypes("host"));
  });

  it("公開契約とホスト契約は互いの監査を通らない（監査が混ざらない）", () => {
    expect(auditContractDocument()).toEqual([]);
    expect(auditContractDocument(EXPERIENCE_HOST_CONTRACT_DOCUMENT).join("\n")).toContain("公開 namespace の外です");
    expect(auditHostContractDocument(EXPERIENCE_CONTRACT_DOCUMENT).join("\n")).toContain("ホスト API の範囲");
  });
});

describe("ホスト契約の監査の自己検査", () => {
  it("禁止の項目名・語を足すと失敗する", () => {
    const leaked = clone();
    const provider = leaked.components.schemas.ExperienceProvider;
    provider.properties.contactEmail = { type: "string" };
    provider.properties.stripeAccountId = { type: "string" };
    provider.properties.payoutSchedule = { type: "string" };
    provider.required.push("contactEmail", "stripeAccountId", "payoutSchedule");
    leaked.components.schemas.ExperienceHostAuthMe.properties.user.properties.phoneNumber = { type: "string" };
    leaked.components.schemas.ExperienceHostAuthMe.properties.user.required.push("phoneNumber");
    expect(auditHostContractDocument(leaked)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("ExperienceProvider.contactEmail: ホスト API に入れてはいけない語（email）"),
        expect.stringContaining("ExperienceProvider.stripeAccountId: ホスト API に入れてはいけない名前"),
        expect.stringContaining("ExperienceProvider.payoutSchedule: ホスト API に入れてはいけない語（payout）"),
        expect.stringContaining("ExperienceHostAuthMe.user.phoneNumber"),
      ]),
    );
  });

  it("閉じていない object・印の無い schema・使われない schema を見つける", () => {
    const loose = clone();
    loose.components.schemas.ExperienceProviderConsent.additionalProperties = true;
    delete loose.components.schemas.ExperienceProviderKind["x-niho-experience-host-dto"];
    loose.components.schemas.ExperienceProviderPaymentReuseCandidate.properties.extra = { type: "object", properties: { a: { type: "string" } }, required: ["a"] };
    loose.components.schemas.ExperienceProviderPaymentReuseCandidate.required.push("extra");
    loose.components.schemas.Unused = { "x-niho-experience-host-dto": true, type: "object", properties: {}, additionalProperties: false };
    expect(auditHostContractDocument(loose)).toEqual(
      expect.arrayContaining([
        "ExperienceProviderConsent: additionalProperties: false が必要です",
        "ExperienceProviderKind: x-niho-experience-host-dto: true が必要です",
        "ExperienceProviderPaymentReuseCandidate.extra: additionalProperties: false が必要です",
        expect.stringContaining("Unused: どの操作からも辿れない schema"),
      ]),
    );
  });

  it("範囲の外の path・Bearer でない security・me の書き込みを見つける", () => {
    const widened = clone();
    widened.paths["/api/users/{userId}"] = { get: { operationId: "getUser", security: [{ FirebaseIdToken: [] }], responses: {} } };
    widened.paths["/api/experience-providers"].get.security = [];
    widened.paths["/api/experience-providers/{providerId}"].patch.security = [{ AppConnectWebAccessToken: [] }, {}];
    widened.paths["/api/auth/me"].delete = { operationId: "deleteMe", security: [{ AppConnectWebAccessToken: [] }], responses: {} };
    expect(auditHostContractDocument(widened)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("/api/users/{userId}: ホスト API の範囲"),
        "GET /api/experience-providers: security は [{ AppConnectWebAccessToken: [] }] だけにします",
        "PATCH /api/experience-providers/{providerId}: security は [{ AppConnectWebAccessToken: [] }] だけにします",
        expect.stringContaining("DELETE /api/auth/me: この path で使える method は GET だけです"),
      ]),
    );
  });

  it("許した名前でも別の schema・別の語では失敗し、禁止の語が別の場所に出ても失敗する", () => {
    const leaked = clone();
    const schemas = leaked.components.schemas;
    // objectKey を許したのは写真の schema だけ（提供者・掲載には置けない）
    schemas.ExperienceProvider.properties.objectKey = { type: "string" };
    schemas.ExperienceProvider.required.push("objectKey");
    schemas.ExperienceProviderPageListing.properties.coverObjectKey = { type: "string" };
    schemas.ExperienceProviderPageListing.required.push("coverObjectKey");
    // address を許したのは集合場所の schema だけ（体験ページの本文・提供者には置けない）
    schemas.SpotCampaignPageExperienceContent.properties.meetingPoint.properties.address = { type: "string" };
    schemas.SpotCampaignPageExperienceContent.properties.meetingPoint.required.push("address");
    schemas.ExperienceProvider.properties.address = { type: "string" };
    schemas.ExperienceProvider.required.push("address");
    // 許した schema でも、許していない名前・ほかの語は失敗する
    schemas.ExperienceProviderMeetingPoint.properties.billingAddress = { type: "string" };
    schemas.ExperienceProviderMeetingPoint.required.push("billingAddress");
    schemas.ExperienceProviderMeetingPoint.properties.contactEmail = { type: "string" };
    schemas.ExperienceProviderMeetingPoint.required.push("contactEmail");
    schemas.AdminCampaignPagePhoto.properties.objectKeySecret = { type: "string" };
    schemas.AdminCampaignPagePhoto.required.push("objectKeySecret");
    // oneOf の組の中に出ても見つける
    schemas.ExperienceHostErrorDetails.oneOf[3].properties.address = { type: "string" };
    schemas.ExperienceHostErrorDetails.oneOf[3].required.push("address");
    expect(auditHostContractDocument(leaked)).toEqual(
      expect.arrayContaining([
        "ExperienceProvider.objectKey: ホスト API に入れてはいけない語（objectkey）を含みます",
        "ExperienceProviderPageListing.coverObjectKey: ホスト API に入れてはいけない語（objectkey）を含みます",
        "SpotCampaignPageExperienceContent.meetingPoint.address: ホスト API に入れてはいけない語（address）を含みます",
        "ExperienceProvider.address: ホスト API に入れてはいけない語（address）を含みます",
        "ExperienceProviderMeetingPoint.billingAddress: ホスト API に入れてはいけない語（billing）を含みます",
        "ExperienceProviderMeetingPoint.contactEmail: ホスト API に入れてはいけない語（email）を含みます",
        "AdminCampaignPagePhoto.objectKeySecret: ホスト API に入れてはいけない語（secret）を含みます",
        "ExperienceHostErrorDetails[3].address: ホスト API に入れてはいけない語（address）を含みます",
      ]),
    );
    // 許した名前そのものは今の場所では通る
    expect(auditHostContractDocument().join("\n")).not.toMatch(/objectkey|address/);
  });

  it("許可リストに契約に無い名前・当たらない名前・禁止でない語を書くと失敗する", () => {
    const policy = structuredClone(EXPERIENCE_HOST_FIELD_POLICY);
    policy.allowedPropertyNames.photoObjectKey!.schemas.ExperienceProvider = ["objectKey"];
    policy.allowedPropertyNames.meetingPointAddress!.schemas.ExperienceProviderMeetingPoint!.push("overview");
    policy.allowedPropertyNames.extra = { token: "zipcode", reason: "（test）", schemas: {} };
    expect(auditHostContractDocument(EXPERIENCE_HOST_CONTRACT_DOCUMENT, policy)).toEqual(
      expect.arrayContaining([
        "host-field-policy.json の allowedPropertyNames.photoObjectKey の ExperienceProvider.objectKey が契約にありません",
        "host-field-policy.json の allowedPropertyNames.meetingPointAddress の ExperienceProviderMeetingPoint.overview は address に当たりません（許す必要がない）",
        "host-field-policy.json の allowedPropertyNames.extra: zipcode は禁止の語にありません（許す必要がない）",
      ]),
    );
    // 許可リストが無ければ、今の契約の写真の識別子と住所は違反になる（例外は許可リストだけが作る）
    const strict = { ...structuredClone(EXPERIENCE_HOST_FIELD_POLICY), allowedPropertyNames: {} };
    expect(auditHostContractDocument(EXPERIENCE_HOST_CONTRACT_DOCUMENT, strict)).toEqual(
      expect.arrayContaining([
        "AdminCampaignPagePhoto.objectKey: ホスト API に入れてはいけない語（objectkey）を含みます",
        "ExperienceProviderMeetingPoint.address: ホスト API に入れてはいけない語（address）を含みます",
      ]),
    );
  });

  it("oneOf の組が閉じていない・何でも通る組を見つける", () => {
    const loose = clone();
    const details = loose.components.schemas.ExperienceHostErrorDetails;
    details.oneOf[3].additionalProperties = true;
    details.oneOf.push({ description: "（test）何でも通る組" });
    loose.components.schemas.ExperienceProviderPageMeetingPointUpdateRequest.oneOf[1].properties.meetingPoint = { type: "object", properties: { note: { type: "string" } } };
    loose.components.schemas.ExperienceProviderPagePreviewOccurrence.oneOf[0].required = ["date"];
    expect(auditHostContractDocument(loose)).toEqual(
      expect.arrayContaining([
        "ExperienceHostErrorDetails[3]: additionalProperties: false が必要です",
        "ExperienceHostErrorDetails.oneOf[8]: 何でも通る組です（閉じた object か $ref か型を書く）",
        "ExperienceProviderPageMeetingPointUpdateRequest[1].meetingPoint: additionalProperties: false が必要です",
        expect.stringContaining("ExperienceProviderPagePreviewOccurrence[0]: 応答の項目は常に返す"),
      ]),
    );
  });

  it("応答の項目を任意にすると失敗する", () => {
    const optional = clone();
    optional.components.schemas.ExperienceProviderListResponse.required = ["providers"];
    expect(auditHostContractDocument(optional).join("\n")).toContain("ExperienceProviderListResponse: 応答の項目は常に返す");
  });
});
