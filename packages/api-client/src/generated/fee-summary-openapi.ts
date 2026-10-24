// このファイルは scripts/gen-types.ts が contract/experience-fee-summary-api.openapi.json から生成する。手で編集しない。
// 更新: npm -C packages/api-client run gen:types
export type paths = {
    "/api/admin/experience-bookings/{requestId}/fee-summary": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * platform ADMINが体験料金の最小精算summaryを読む
         * @description 固定GET。元口座・Stripe ID・内部hash・旅行者PIIを返さず、全応答をprivate no-storeにする。
         */
        get: operations["getAdminExperienceBookingFeeSummary"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/experience-providers/management/bookings/{requestId}/fee-summary": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * 現在OWNER本人が両host kindの体験料金summaryを読む
         * @description 固定GET。Provider vesselと通常Spotを本人の管理範囲だけで選別し、元口座・Stripe ID・内部hash・旅行者PIIを返さない。
         */
        get: operations["getManagedExperienceBookingFeeSummary"];
        put?: never;
        post?: never;
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
        ExperienceFeeSummary: {
            accounting: components["schemas"]["ExperienceFeeSummaryAccounting"] | null;
            bookingRequestId: string;
            /** Format: date-time */
            evidenceCheckedAt: string | null;
            feePolicy: components["schemas"]["ExperienceFeeSummaryPolicy"] | null;
            needsAttention: boolean;
            reason: string | null;
            /** Format: date-time */
            settledAt: string | null;
            /** @enum {string} */
            status: "LEGACY_NOT_RECORDED" | "PREPARING" | "PROCESSING_COST_PENDING" | "PROCESSING" | "RESULT_UNKNOWN" | "REVIEW_REQUIRED" | "SETTLED";
            /** @enum {string} */
            version: "1.0.0";
        };
        ExperienceFeeSummaryAccounting: {
            applicationFeeRefundedYen: number | null;
            hostRetainedAfterCreditsYen: number | null;
            netNihoCashYen: number | null;
            pendingRefundedYen: number | null;
            processingCompensatedYen: number | null;
            successfulRefundedYen: number | null;
            targetApplicationFeeRefundYen: number | null;
            targetProcessingCompensationYen: number | null;
            targetTotalFeeYen: number | null;
        };
        ExperienceFeeSummaryError: {
            error: {
                code: string;
                details: {
                    [key: string]: unknown;
                };
                message: string;
            };
        };
        ExperienceFeeSummaryPolicy: {
            /** @enum {boolean} */
            laborPaidDirectlyByHost: true;
            originalApplicationFeeYen: number;
            originalGrossYen: number;
            /** @enum {boolean} */
            processingFeesIncluded: true;
            supportEnabled: boolean;
            /** @enum {integer} */
            totalRateBps: 1000 | 1500;
        };
        ExperienceFeeSummaryResponse: {
            feeSummary: components["schemas"]["ExperienceFeeSummary"];
        };
    };
    responses: never;
    parameters: never;
    requestBodies: never;
    headers: {
        /** @description 体験料金のAdmin/Host本人向けsummaryを共有cacheへ保存しない。 */
        ExperienceFeeSummaryPrivateNoStore: "private, no-store";
    };
    pathItems: never;
};
export type $defs = Record<string, never>;
export interface operations {
    getAdminExperienceBookingFeeSummary: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                requestId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description OK */
            200: {
                headers: {
                    "Cache-Control": components["headers"]["ExperienceFeeSummaryPrivateNoStore"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ExperienceFeeSummaryResponse"];
                };
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ExperienceFeeSummaryError"];
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ExperienceFeeSummaryError"];
                };
            };
            /** @description Not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ExperienceFeeSummaryError"];
                };
            };
            /** @description Method not allowed */
            405: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ExperienceFeeSummaryError"];
                };
            };
        };
    };
    getManagedExperienceBookingFeeSummary: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                requestId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description OK */
            200: {
                headers: {
                    "Cache-Control": components["headers"]["ExperienceFeeSummaryPrivateNoStore"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ExperienceFeeSummaryResponse"];
                };
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ExperienceFeeSummaryError"];
                };
            };
            /** @description Not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ExperienceFeeSummaryError"];
                };
            };
            /** @description Method not allowed */
            405: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ExperienceFeeSummaryError"];
                };
            };
        };
    };
}
