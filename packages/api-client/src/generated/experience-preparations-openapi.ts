// このファイルは scripts/gen-types.ts が contract/experience-preparations-api.openapi.json から生成する。手で編集しない。
// 更新: npm -C packages/api-client run gen:types
export type paths = {
    "/admin/assignment-candidates": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** 担当候補者を表示名で検索する */
        get: operations["searchExperiencePreparationAssignmentCandidates"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/cases": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** 準備案件を一覧する */
        get: operations["listExperiencePreparationCases"];
        put?: never;
        /** 準備案件を作る */
        post: operations["createExperiencePreparationCase"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/cases/{caseId}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                caseId: components["parameters"]["CaseId"];
            };
            cookie?: never;
        };
        /** 準備案件の詳細を読む */
        get: operations["getExperiencePreparationCase"];
        put?: never;
        post?: never;
        /** 取消済み案件のPIIを破棄する */
        delete: operations["purgeExperiencePreparationCasePii"];
        options?: never;
        head?: never;
        /** 準備案件を改訂する */
        patch: operations["updateExperiencePreparationCase"];
        trace?: never;
    };
    "/admin/cases/{caseId}/assignments/{userId}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                caseId: components["parameters"]["CaseId"];
                userId: components["parameters"]["UserId"];
            };
            cookie?: never;
        };
        get?: never;
        /** 案件担当者を割り当てる */
        put: operations["assignExperiencePreparationCollaborator"];
        post?: never;
        /** 案件担当者を外す */
        delete: operations["removeExperiencePreparationCollaborator"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/cases/{caseId}/cancel": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                caseId: components["parameters"]["CaseId"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** 準備案件を取り消す */
        post: operations["cancelExperiencePreparation"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/cases/{caseId}/materialize": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                caseId: components["parameters"]["CaseId"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** 承認済み案件を正式商品へ反映する */
        post: operations["materializeExperiencePreparation"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/cases/{caseId}/preview-tokens": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                caseId: components["parameters"]["CaseId"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** 限定プレビューtokenを発行する */
        post: operations["issueExperiencePreparationPreviewToken"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/cases/{caseId}/representative-verification": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                caseId: components["parameters"]["CaseId"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** 受入本人と版を確認する */
        post: operations["verifyExperiencePreparationRepresentative"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/cases/{caseId}/uploads/policies": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                caseId: components["parameters"]["CaseId"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** 案件写真のupload policyを発行する */
        post: operations["createExperiencePreparationImageUploadPolicy"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/host/cases": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** 本人又は担当案件を一覧する */
        get: operations["listMyExperiencePreparationCases"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/host/cases/{caseId}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                caseId: components["parameters"]["CaseId"];
            };
            cookie?: never;
        };
        /** 本人又は担当案件を読む */
        get: operations["getMyExperiencePreparationCase"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /** 担当案件を改訂する */
        patch: operations["editAssignedExperiencePreparationDraft"];
        trace?: never;
    };
    "/host/cases/{caseId}/accept": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                caseId: components["parameters"]["CaseId"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** 本人が案と各規約へ同意する */
        post: operations["acceptExperiencePreparation"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/host/cases/{caseId}/correction-requests": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                caseId: components["parameters"]["CaseId"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** 本人又は担当者が修正を依頼する */
        post: operations["requestExperiencePreparationCorrection"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/host/cases/{caseId}/readiness": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                caseId: components["parameters"]["CaseId"];
            };
            cookie?: never;
        };
        /** 販売準備状態を読む */
        get: operations["getExperiencePreparationReadiness"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/host/cases/{caseId}/revoke-acceptance": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                caseId: components["parameters"]["CaseId"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** 本人が現在の受入を取り消す */
        post: operations["revokeExperiencePreparationAcceptance"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/review": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** 限定プレビューを読む */
        post: operations["reviewExperiencePreparation"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/review/correction-requests": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** 匿名プレビューから修正を依頼する */
        post: operations["requestExperiencePreparationCorrectionAnonymously"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
};
export type webhooks = Record<string, never>;
export type components = {
    schemas: {
        Acceptance: {
            acceptedAt: components["schemas"]["DateTime"];
            acceptedBy: components["schemas"]["UserLabel"];
            agreementVersion: string;
            id: string;
            listingConsentVersion: string;
            providerConsentVersion: string | null;
            revision: number;
            revokedAt: components["schemas"]["NullableDateTime"];
            snapshotHash: components["schemas"]["Hash"];
        };
        AcceptanceInput: {
            agreementVersion: string;
            caseVersion: number;
            /** @constant */
            contentAccepted: true;
            /** @constant */
            listingAuthorized: true;
            listingConsentVersion: string;
            providerConsent: null | {
                /** @constant */
                accepted: true;
                version: string;
            };
            /** @constant */
            representativeDeclared: true;
            reviewToken: components["schemas"]["ReviewToken"];
            /** @constant */
            salesTermsAccepted: true;
            snapshotHash: components["schemas"]["Hash"];
            /** @constant */
            supportAuthorized: true;
            target: components["schemas"]["Target"];
        };
        /** @enum {string|null} */
        Access: "REPRESENTATIVE" | "DRAFT_EDITOR" | "COORDINATOR" | null;
        AdminCase: {
            acceptanceHistory: components["schemas"]["Acceptance"][];
            assignments: components["schemas"]["Assignment"][];
            contact: {
                /** Format: email */
                email: string;
                name: string;
            } | null;
            createdAt: components["schemas"]["DateTime"];
            currentAcceptance: components["schemas"]["Acceptance"] | null;
            id: string;
            images: components["schemas"]["Image"][];
            materialized: components["schemas"]["Materialized"] | null;
            pageSlugBase: string;
            proposal: components["schemas"]["Proposal"] | null;
            representativeVerifiedAcceptanceId: string | null;
            representativeVerifiedAt: components["schemas"]["NullableDateTime"];
            revision: number;
            snapshotHash: components["schemas"]["Hash"];
            status: components["schemas"]["Status"];
            supportScopes: string[];
            updatedAt: components["schemas"]["DateTime"];
        };
        AdminCaseDetailResponse: {
            audits: components["schemas"]["Audit"][];
            case: components["schemas"]["AdminCase"];
            correctionRequests: components["schemas"]["CorrectionAdmin"][];
            readiness: components["schemas"]["Readiness"] | null;
        };
        AdminCaseListItem: {
            case: components["schemas"]["AdminCase"];
            nextAction: string;
            readiness?: components["schemas"]["Readiness"];
            waitingOn: components["schemas"]["WaitingOn"];
        };
        Assignment: {
            createdAt: components["schemas"]["DateTime"];
            role: components["schemas"]["AssignmentRole"];
            user: components["schemas"]["UserLabel"];
        };
        /** @enum {string} */
        AssignmentRole: "DRAFT_EDITOR" | "COORDINATOR";
        Audit: {
            action: string;
            actorUserId: string | null;
            createdAt: components["schemas"]["DateTime"];
            id: string;
            revision: number | null;
            targetId: string | null;
        };
        ConsentSet: {
            listing: components["schemas"]["ConsentText"];
            preparation: components["schemas"]["ConsentText"];
            provider: {
                required: boolean;
                text: string;
                version: string;
            };
        };
        ConsentText: {
            text: string | {
                content: string;
                representative: string;
                salesTerms: string;
                support: string;
            };
            version: string;
        };
        CorrectionAdmin: {
            createdAt: components["schemas"]["DateTime"];
            id: string;
            message: string;
            requestedByUserId: string | null;
            revision: number;
        };
        CorrectionCreated: {
            createdAt: components["schemas"]["DateTime"];
            id: string;
        };
        CorrectionMessage: string;
        /** Format: date-time */
        DateTime: string;
        Draft: {
            offer: components["schemas"]["Offer"];
            operatingRoles: components["schemas"]["OperatingRole"][];
            pages: components["schemas"]["Pages"];
            pageSlugBase: string;
            photos: components["schemas"]["Photo"][];
            provider: components["schemas"]["ProviderDraft"];
            supportScopes: ("DRAFT_EDITING" | "TRANSLATION" | "SCHEDULING" | "ONBOARDING_GUIDANCE")[];
            target: components["schemas"]["Target"];
        };
        EditorDraft: {
            pages?: components["schemas"]["Pages"];
            photos?: components["schemas"]["Photo"][];
        };
        EditorPatchInput: {
            draft: components["schemas"]["EditorDraft"];
            expectedRevision: number;
        };
        ErrorResponse: {
            error: {
                /** @enum {string} */
                code: "VALIDATION_ERROR" | "UNAUTHORIZED" | "FORBIDDEN" | "ACCOUNT_DELETED" | "NOT_FOUND" | "CONFLICT" | "UNPROCESSABLE_ENTITY" | "SERVICE_UNAVAILABLE" | "INTERNAL";
                details: {
                    field?: string;
                    reason?: string;
                };
                message: string;
            };
        };
        ExperienceContent: {
            description: string;
            facts: {
                language: string;
            };
            highlights: string[];
            hostUserIds: string[];
            included: components["schemas"]["ShortTextList"];
            knowBeforeYouGo: string[];
            lead: string;
            meetingPoint: {
                entranceNote: string;
                exteriorPhotoObjectKey: string | null;
            };
            notIncluded: components["schemas"]["ShortTextList"];
            notSuitableFor: components["schemas"]["ShortTextList"];
            timeline: components["schemas"]["TimelineItem"][];
        };
        Hash: string;
        HostCase: {
            access: components["schemas"]["Access"];
            consents: components["schemas"]["ConsentSet"];
            currentAcceptance: components["schemas"]["MyAcceptance"] | null;
            id: string;
            images: components["schemas"]["Image"][];
            materialized: components["schemas"]["Materialized"] | null;
            proposal: components["schemas"]["Proposal"];
            representativeVerifiedAt: components["schemas"]["NullableDateTime"];
            revision: number;
            snapshotHash: components["schemas"]["Hash"];
            status: components["schemas"]["Status"];
            updatedAt: components["schemas"]["DateTime"];
        };
        Image: {
            alt: string;
            expiresAt: components["schemas"]["NullableDateTime"];
            objectKey: string;
            /** Format: uri */
            signedUrl: string | null;
            thumbExpiresAt: components["schemas"]["NullableDateTime"];
            /** Format: uri */
            thumbSignedUrl: string | null;
        };
        LockedAcceptanceInput: {
            acceptedByUserId: string;
            expectedRevision: number;
            snapshotHash: components["schemas"]["Hash"];
        };
        Materialized: {
            at: components["schemas"]["NullableDateTime"];
            pageEnId: string;
            pageJaId: string;
            providerId: string;
        };
        MaterializeResult: {
            created: boolean;
            pageEnId: string;
            pageJaId: string;
            providerId: string;
        };
        MyAcceptance: {
            acceptedAt: components["schemas"]["DateTime"];
            /** @constant */
            acceptedByMe: true;
            agreementVersion: string;
            id: string;
            listingConsentVersion: string;
            providerConsentVersion: string | null;
            revision: number;
            revokedAt: components["schemas"]["NullableDateTime"];
            snapshotHash: components["schemas"]["Hash"];
        };
        NullableDateTime: components["schemas"]["DateTime"] | null;
        Offer: {
            /** @enum {string} */
            acceptanceMode: "INSTANT" | "REQUEST";
            adultRequiredForChild: boolean;
            /** @enum {string} */
            cancellationPolicy: "FLEXIBLE" | "MODERATE" | "STRICT";
            capacity: number;
            childMaxAge: number | null;
            childMinAge: number | null;
            childPriceYen: number | null;
            closedDates: string[];
            cutoffDays: number;
            durationMinutes: number;
            maxPartySize: number;
            minimumParticipants: number;
            nameEn: string;
            nameJa: string;
            priceYen: number;
            shortDescriptionEn: string | null;
            shortDescriptionJa: string | null;
            startTime: string;
            weekdays: number[];
        };
        OperatingRole: {
            /** @enum {string} */
            party: "PROVIDER" | "NIHO" | "COLLABORATOR";
            responsibilities: string[];
        };
        PageDraft: {
            content: components["schemas"]["ExperienceContent"];
            title: string;
        };
        Pages: {
            en: components["schemas"]["PageDraft"];
            ja: components["schemas"]["PageDraft"];
        };
        Photo: {
            alt: string;
            objectKey: string;
        };
        PreviewTokenResponse: {
            expiresAt: components["schemas"]["DateTime"];
            revision: number;
            token: components["schemas"]["ReviewToken"];
        };
        Proposal: {
            offer: components["schemas"]["Offer"];
            operatingRoles: components["schemas"]["OperatingRole"][];
            pages: components["schemas"]["Pages"];
            pageSlugBase: string;
            photos: components["schemas"]["Photo"][];
            provider: components["schemas"]["ProviderProposal"];
            target: components["schemas"]["Target"];
        };
        ProviderDraft: {
            bio: string;
            /** Format: email */
            contactEmail: string;
            contactName: string;
            displayName: string;
            /** @enum {string} */
            kind: "INDIVIDUAL" | "BUSINESS";
            /** Format: uri */
            sellerDisclosureUrl: string | null;
        };
        ProviderProposal: {
            bio: string;
            displayName: string;
            /** @enum {string} */
            kind: "INDIVIDUAL" | "BUSINESS";
            /** Format: uri */
            sellerDisclosureUrl: string | null;
        };
        Readiness: {
            blockers: string[];
            editUrl: string | null;
            /** @enum {string} */
            listing: "NOT_REQUESTED" | "REQUESTED" | "ACTIVE" | "PAUSED" | "WITHDRAWN" | "NOT_MATERIALIZED" | "UNKNOWN";
            nextAction: string;
            /** @enum {string} */
            payment: "NOT_CONNECTED" | "VERIFICATION_REQUIRED" | "CHARGES_DISABLED" | "PAYOUTS_DISABLED" | "RESTRICTED" | "READY" | "NOT_MATERIALIZED";
            paymentUrl: string | null;
            /** @enum {string} */
            products: "NOT_MATERIALIZED" | "DRAFT_READY" | "DRAFT_INCOMPLETE" | "APPROVED_SNAPSHOT_CHANGED";
            providerId: string | null;
            /** @enum {string} */
            providerReview: "DRAFT" | "REQUESTED" | "APPROVED" | "SUSPENDED" | "NOT_MATERIALIZED" | "UNKNOWN";
            /** @enum {string} */
            representativeAcceptance: "WAITING" | "ACCEPTED" | "STALE";
            /** @enum {string} */
            representativeVerification: "WAITING" | "VERIFIED" | "STALE";
            support: {
                authorized: boolean;
                roles: components["schemas"]["OperatingRole"][];
            };
            waitingOn: components["schemas"]["WaitingOn"];
        };
        ReviewResponse: {
            caseId: string;
            consents: components["schemas"]["ConsentSet"];
            expiresAt: components["schemas"]["DateTime"];
            images: components["schemas"]["Image"][];
            proposal: components["schemas"]["Proposal"];
            revision: number;
            snapshotHash: components["schemas"]["Hash"];
            /** @enum {string} */
            status: "REVIEW" | "ACCEPTED" | "REPRESENTATIVE_VERIFIED";
        };
        ReviewToken: string;
        ShortTextList: string[];
        /** @enum {string} */
        Status: "DRAFT" | "REVIEW" | "ACCEPTED" | "REPRESENTATIVE_VERIFIED" | "MATERIALIZED" | "CANCELLED";
        Target: {
            /** @constant */
            mode: "NEW_PROVIDER";
            providerId: null;
        } | {
            /** @constant */
            mode: "EXISTING_PROVIDER";
            providerId: string;
        };
        TimelineItem: {
            photoObjectKey: string | null;
            text: string;
            time: string;
            title: string;
        };
        UploadPolicyInput: {
            contentLength: number;
            /** @enum {string} */
            contentType: "image/jpeg" | "image/png" | "image/webp";
        };
        UploadPolicyResponse: {
            expiresAt: components["schemas"]["DateTime"];
            maxSizeBytes: number;
            objectKey: string;
            upload: {
                fields: {
                    [key: string]: string;
                };
                /** Format: uri */
                url: string;
            };
            uploadId: string;
        };
        UserLabel: {
            displayName: string;
            userId: string;
        };
        /** @enum {string} */
        WaitingOn: "NIHO" | "REPRESENTATIVE" | "PAYMENT" | "PROVIDER_REVIEW" | "LISTING_REVIEW" | "NONE";
    };
    responses: {
        /** @description 入力不正 */
        BadRequest: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["ErrorResponse"];
            };
        };
        /** @description revision・状態・受入競合 */
        Conflict: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["ErrorResponse"];
            };
        };
        /** @description 受付済み */
        CorrectionCreated: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": {
                    request: components["schemas"]["CorrectionCreated"];
                };
            };
        };
        /** @description 権限又は本人確認不足 */
        Forbidden: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["ErrorResponse"];
            };
        };
        /** @description 不存在・権限外・token失効/期限切れを区別しない */
        NotFound: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["ErrorResponse"];
            };
        };
        /** @description 限定preview */
        Review: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["ReviewResponse"];
            };
        };
        /** @description Upload署名利用不可 */
        Unavailable: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["ErrorResponse"];
            };
        };
        /** @description 規約版・写真binding・同意不足 */
        Unprocessable: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["ErrorResponse"];
            };
        };
    };
    parameters: {
        CaseId: string;
        UserId: string;
    };
    requestBodies: {
        AnonymousCorrection: {
            content: {
                "application/json": {
                    message: components["schemas"]["CorrectionMessage"];
                    token: components["schemas"]["ReviewToken"];
                };
            };
        };
        Correction: {
            content: {
                "application/json": {
                    message: components["schemas"]["CorrectionMessage"];
                };
            };
        };
        CreateCase: {
            content: {
                "application/json": {
                    draft: components["schemas"]["Draft"];
                };
            };
        };
        LockedAcceptance: {
            content: {
                "application/json": components["schemas"]["LockedAcceptanceInput"];
            };
        };
        PatchCase: {
            content: {
                "application/json": {
                    draft: components["schemas"]["Draft"];
                    expectedRevision: number;
                };
            };
        };
        ReviewToken: {
            content: {
                "application/json": {
                    token: components["schemas"]["ReviewToken"];
                };
            };
        };
    };
    headers: never;
    pathItems: never;
};
export type $defs = Record<string, never>;
export interface operations {
    searchExperiencePreparationAssignmentCandidates: {
        parameters: {
            query: {
                q: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description 候補（最大20件・PII最小） */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        candidates: components["schemas"]["UserLabel"][];
                    };
                };
            };
            400: components["responses"]["BadRequest"];
            403: components["responses"]["Forbidden"];
        };
    };
    listExperiencePreparationCases: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description 案件一覧 */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        cases: components["schemas"]["AdminCaseListItem"][];
                    };
                };
            };
            403: components["responses"]["Forbidden"];
        };
    };
    createExperiencePreparationCase: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: components["requestBodies"]["CreateCase"];
        responses: {
            /** @description 作成済み */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        case: components["schemas"]["AdminCase"];
                    };
                };
            };
            400: components["responses"]["BadRequest"];
            403: components["responses"]["Forbidden"];
            422: components["responses"]["Unprocessable"];
        };
    };
    getExperiencePreparationCase: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                caseId: components["parameters"]["CaseId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description 管理者向け案件 */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AdminCaseDetailResponse"];
                };
            };
            404: components["responses"]["NotFound"];
        };
    };
    purgeExperiencePreparationCasePii: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                caseId: components["parameters"]["CaseId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description 取消済み案件のPII本文をscrubし、同意version/hash履歴を保持 */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
        };
    };
    updateExperiencePreparationCase: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                caseId: components["parameters"]["CaseId"];
            };
            cookie?: never;
        };
        requestBody: components["requestBodies"]["PatchCase"];
        responses: {
            /** @description 改訂済み */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        case: components["schemas"]["AdminCase"];
                    };
                };
            };
            400: components["responses"]["BadRequest"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["Unprocessable"];
        };
    };
    assignExperiencePreparationCollaborator: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                caseId: components["parameters"]["CaseId"];
                userId: components["parameters"]["UserId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    role: components["schemas"]["AssignmentRole"];
                };
            };
        };
        responses: {
            /** @description 付与 */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        assignment: components["schemas"]["Assignment"];
                    };
                };
            };
            404: components["responses"]["NotFound"];
        };
    };
    removeExperiencePreparationCollaborator: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                caseId: components["parameters"]["CaseId"];
                userId: components["parameters"]["UserId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description 取消 */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            404: components["responses"]["NotFound"];
        };
    };
    cancelExperiencePreparation: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                caseId: components["parameters"]["CaseId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description token・担当・現在受入を失効し、未正式化PII/画像を回収 */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** @constant */
                        cancelled: true;
                        materialized: boolean;
                    };
                };
            };
            404: components["responses"]["NotFound"];
        };
    };
    materializeExperiencePreparation: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                caseId: components["parameters"]["CaseId"];
            };
            cookie?: never;
        };
        requestBody: components["requestBodies"]["LockedAcceptance"];
        responses: {
            /** @description 冪等な正式化又は承認済み改訂の反映 */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        materialized: components["schemas"]["MaterializeResult"];
                    };
                };
            };
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["Unprocessable"];
        };
    };
    issueExperiencePreparationPreviewToken: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                caseId: components["parameters"]["CaseId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description 平文tokenを一度だけ返す */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PreviewTokenResponse"];
                };
            };
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
        };
    };
    verifyExperiencePreparationRepresentative: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                caseId: components["parameters"]["CaseId"];
            };
            cookie?: never;
        };
        requestBody: components["requestBodies"]["LockedAcceptance"];
        responses: {
            /** @description 画面で確認した本人・版を照合 */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        case: components["schemas"]["AdminCase"];
                    };
                };
            };
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
        };
    };
    createExperiencePreparationImageUploadPolicy: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                caseId: components["parameters"]["CaseId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["UploadPolicyInput"];
            };
        };
        responses: {
            /** @description 案件binding済みUpload */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["UploadPolicyResponse"];
                };
            };
            400: components["responses"]["BadRequest"];
            404: components["responses"]["NotFound"];
            503: components["responses"]["Unavailable"];
        };
    };
    listMyExperiencePreparationCases: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description 本人又は担当案件 */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        cases: components["schemas"]["HostCase"][];
                    };
                };
            };
            403: components["responses"]["Forbidden"];
        };
    };
    getMyExperiencePreparationCase: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                caseId: components["parameters"]["CaseId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description 案件 */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        case: components["schemas"]["HostCase"];
                    };
                };
            };
            404: components["responses"]["NotFound"];
        };
    };
    editAssignedExperiencePreparationDraft: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                caseId: components["parameters"]["CaseId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["EditorPatchInput"];
            };
        };
        responses: {
            /** @description 改訂済み */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        case: components["schemas"]["HostCase"];
                    };
                };
            };
            400: components["responses"]["BadRequest"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["Unprocessable"];
        };
    };
    acceptExperiencePreparation: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                caseId: components["parameters"]["CaseId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["AcceptanceInput"];
            };
        };
        responses: {
            /** @description 本人受入 */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        acceptance: components["schemas"]["MyAcceptance"];
                    };
                };
            };
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["Unprocessable"];
        };
    };
    requestExperiencePreparationCorrection: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                caseId: components["parameters"]["CaseId"];
            };
            cookie?: never;
        };
        requestBody: components["requestBodies"]["Correction"];
        responses: {
            201: components["responses"]["CorrectionCreated"];
            400: components["responses"]["BadRequest"];
            404: components["responses"]["NotFound"];
        };
    };
    getExperiencePreparationReadiness: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                caseId: components["parameters"]["CaseId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description 販売準備状態 */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        readiness: components["schemas"]["Readiness"];
                    };
                };
            };
            404: components["responses"]["NotFound"];
        };
    };
    revokeExperiencePreparationAcceptance: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                caseId: components["parameters"]["CaseId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description 受入取消 */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** @constant */
                        revoked: true;
                    };
                };
            };
            404: components["responses"]["NotFound"];
        };
    };
    reviewExperiencePreparation: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: components["requestBodies"]["ReviewToken"];
        responses: {
            200: components["responses"]["Review"];
            400: components["responses"]["BadRequest"];
            404: components["responses"]["NotFound"];
        };
    };
    requestExperiencePreparationCorrectionAnonymously: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: components["requestBodies"]["AnonymousCorrection"];
        responses: {
            201: components["responses"]["CorrectionCreated"];
            400: components["responses"]["BadRequest"];
            404: components["responses"]["NotFound"];
        };
    };
}
