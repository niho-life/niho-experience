// このファイルは scripts/gen-types.ts が contract/experience-host-support-history-api.openapi.json から生成する。手で編集しない。
// 更新: npm -C packages/api-client run gen:types
export type paths = {
    "/api/experience-providers/management/bookings/{requestId}/support-history": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * ホスト本人がNIHO事務局の対応履歴を読む
         * @description 両host kindの本人管理範囲だけ。最大50件の最小metadataで、内部メモ・actor連絡先・payload hash・Stripe IDは返さない。
         */
        get: operations["getManagedExperienceBookingSupportHistory"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/experience-providers/management/bookings/{requestId}/support-history/{operationId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * ホスト本人がNIHO事務局の対応詳細を読む
         * @description 本人予約の既存message/cancelMessage参照から連絡本文を返す。事務局内部メモは返さない。
         */
        get: operations["getManagedExperienceBookingSupportHistoryDetail"];
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
        ExperienceHostSupportCommunication: {
            body: string | null;
            /** @enum {string|null} */
            deliveryStatus: "PENDING" | "SENT" | "FAILED" | "UNKNOWN" | null;
            messageId: string | null;
            retained: boolean;
            subject: string | null;
        } | null;
        ExperienceHostSupportHistoryDetail: {
            /** @enum {string} */
            action: "APPROVE" | "DECLINE" | "CANCEL" | "MESSAGE";
            /** @enum {string} */
            actorKind: "NIHO_SUPPORT";
            bookingRequestId: string;
            communication: components["schemas"]["ExperienceHostSupportCommunication"];
            /** Format: date-time */
            completedAt: string | null;
            /** Format: date-time */
            createdAt: string;
            /** Format: uuid */
            operationId: string;
            reasonCode: string | null;
            resultCode: string | null;
            resultRefundedYen: number | null;
            resultStatus: string | null;
            /** @enum {string} */
            state: "ACCEPTED" | "PROCESSING" | "UNKNOWN" | "SUCCEEDED" | "REJECTED" | "FAILED";
        };
        ExperienceHostSupportHistoryDetailResponse: {
            operation: components["schemas"]["ExperienceHostSupportHistoryDetail"];
        };
        ExperienceHostSupportHistoryError: {
            error: {
                code: string;
                details: {
                    [key: string]: unknown;
                };
                message: string;
            };
        };
        ExperienceHostSupportHistoryItem: {
            /** @enum {string} */
            action: "APPROVE" | "DECLINE" | "CANCEL" | "MESSAGE";
            /** @enum {string} */
            actorKind: "NIHO_SUPPORT";
            bookingRequestId: string;
            /** Format: date-time */
            completedAt: string | null;
            /** Format: date-time */
            createdAt: string;
            hasMessage: boolean;
            /** Format: uuid */
            operationId: string;
            reasonCode: string | null;
            resultCode: string | null;
            resultRefundedYen: number | null;
            resultStatus: string | null;
            /** @enum {string} */
            state: "ACCEPTED" | "PROCESSING" | "UNKNOWN" | "SUCCEEDED" | "REJECTED" | "FAILED";
        };
        ExperienceHostSupportHistoryResponse: {
            bookingRequestId: string;
            history: {
                /** @enum {integer} */
                limit: 50;
                truncated: boolean;
            };
            operations: components["schemas"]["ExperienceHostSupportHistoryItem"][];
        };
    };
    responses: never;
    parameters: never;
    requestBodies: never;
    headers: {
        /** @description Admin本人向け応答を共有cacheへ保存しない。 */
        ExperienceAdminPrivateNoStore: "private, no-store";
    };
    pathItems: never;
};
export type $defs = Record<string, never>;
export interface operations {
    getManagedExperienceBookingSupportHistory: {
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
                    "Cache-Control": components["headers"]["ExperienceAdminPrivateNoStore"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ExperienceHostSupportHistoryResponse"];
                };
            };
            /** @description Not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ExperienceHostSupportHistoryError"];
                };
            };
        };
    };
    getManagedExperienceBookingSupportHistoryDetail: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                operationId: string;
                requestId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description OK */
            200: {
                headers: {
                    "Cache-Control": components["headers"]["ExperienceAdminPrivateNoStore"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ExperienceHostSupportHistoryDetailResponse"];
                };
            };
            /** @description Not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ExperienceHostSupportHistoryError"];
                };
            };
        };
    };
}
