// このファイルは scripts/gen-types.ts が contract/experience-admin-support-case-api.openapi.json から生成する。手で編集しない。
// 更新: npm -C packages/api-client run gen:types
export type paths = {
    "/api/admin/experience-bookings/{requestId}/support-case": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * platform ADMINが予約別の事務局支援ケースを読む
         * @description 提供者または通常Spotの体験予約を再検証し、担当・事務局内部メモ・CAS revision・書込可否を返す。
         *     未作成はrevision 0の空状態。ホストへは公開しない。全応答は`Cache-Control: private, no-store`。
         */
        get: operations["getAdminExperienceSupportCase"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /**
         * platform ADMINが予約別の担当・内部メモをCAS更新する
         * @description 支援ONで受け付けた取引PII期限内の予約だけを更新する。担当候補とactorはtransaction内で現在の
         *     platform ADMINかつ未退会であることを再検証する。内部メモ本文は監査・ログへ複製しない。
         */
        patch: operations["patchAdminExperienceSupportCase"];
        trace?: never;
    };
    "/api/admin/experience-support-admins": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * 体験支援ケースへ割り当て可能なplatform ADMINを返す
         * @description 現在有効なplatform ADMINのopaque IDとdisplayNameだけを安定順で最大100件返し、超過はtruncatedで明示する。
         *     全応答は`Cache-Control: private, no-store`。
         */
        get: operations["listAdminExperienceSupportAdmins"];
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
        ExperienceAdminSupportAdmin: {
            displayName: string | null;
            id: string;
        };
        ExperienceAdminSupportAdminListResponse: {
            admins: components["schemas"]["ExperienceAdminSupportAdmin"][];
            truncated: boolean;
        };
        ExperienceAdminSupportCase: {
            assignedAdmin: components["schemas"]["ExperienceAdminSupportCaseAssignment"];
            bookingRequestId: string;
            /** Format: date-time */
            createdAt: string | null;
            internalMemo: string | null;
            revision: number;
            /** Format: date-time */
            updatedAt: string | null;
        };
        ExperienceAdminSupportCaseAssignment: {
            displayName: string | null;
            id: string;
            /** @enum {string} */
            status: "ACTIVE";
        } | {
            /** @enum {string} */
            status: "UNASSIGNED" | "UNAVAILABLE";
        };
        ExperienceAdminSupportCaseErrorResponse: {
            error: {
                code: string;
                details: {
                    [key: string]: unknown;
                };
                message: string;
            };
        };
        ExperienceAdminSupportCasePatchRequest: {
            assignedAdminUserId?: string | null;
            expectedRevision: number;
            internalMemo?: string | null;
        };
        ExperienceAdminSupportCasePatchResponse: {
            supportCase: components["schemas"]["ExperienceAdminSupportCase"];
        };
        ExperienceAdminSupportCaseReadResponse: {
            supportCase: components["schemas"]["ExperienceAdminSupportCase"];
            writeCapability: components["schemas"]["ExperienceAdminSupportCaseWriteCapability"];
        };
        ExperienceAdminSupportCaseWriteCapability: {
            /** @enum {object|null} */
            reason: never | null;
            /** @enum {boolean} */
            writable: true;
        } | {
            /** @enum {string} */
            reason: "WRITES_DISABLED" | "SUPPORT_OFF" | "SUPPORT_LEGACY" | "SUPPORT_INVALID" | "PII_RETENTION_EXPIRED";
            /** @enum {boolean} */
            writable: false;
        };
    };
    responses: {
        /** @description 未定義のHTTPメソッド */
        ExperienceAdminSupportAdminMethodNotAllowed: {
            headers: {
                Allow?: "GET";
                "Cache-Control": components["headers"]["ExperienceAdminSupportCasePrivateNoStore"];
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["ExperienceAdminSupportCaseErrorResponse"];
            };
        };
        /** @description revision競合、担当失効、支援条件またはPII期限により更新不可 */
        ExperienceAdminSupportCaseConflict: {
            headers: {
                "Cache-Control": components["headers"]["ExperienceAdminSupportCasePrivateNoStore"];
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["ExperienceAdminSupportCaseErrorResponse"];
            };
        };
        /** @description 現在有効なplatform ADMIN権限が必要 */
        ExperienceAdminSupportCaseForbidden: {
            headers: {
                "Cache-Control": components["headers"]["ExperienceAdminSupportCasePrivateNoStore"];
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["ExperienceAdminSupportCaseErrorResponse"];
            };
        };
        /** @description 未定義のHTTPメソッド */
        ExperienceAdminSupportCaseMethodNotAllowed: {
            headers: {
                Allow?: "GET, PATCH";
                "Cache-Control": components["headers"]["ExperienceAdminSupportCasePrivateNoStore"];
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["ExperienceAdminSupportCaseErrorResponse"];
            };
        };
        /** @description 対象が無いか現在の体験予約scope外 */
        ExperienceAdminSupportCaseNotFound: {
            headers: {
                "Cache-Control": components["headers"]["ExperienceAdminSupportCasePrivateNoStore"];
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["ExperienceAdminSupportCaseErrorResponse"];
            };
        };
        /** @description 支援書込flagが無効 */
        ExperienceAdminSupportCaseServiceUnavailable: {
            headers: {
                "Cache-Control": components["headers"]["ExperienceAdminSupportCasePrivateNoStore"];
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["ExperienceAdminSupportCaseErrorResponse"];
            };
        };
        /** @description 認証が必要 */
        ExperienceAdminSupportCaseUnauthorized: {
            headers: {
                "Cache-Control": components["headers"]["ExperienceAdminSupportCasePrivateNoStore"];
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["ExperienceAdminSupportCaseErrorResponse"];
            };
        };
        /** @description 入力が不正 */
        ExperienceAdminSupportCaseValidationError: {
            headers: {
                "Cache-Control": components["headers"]["ExperienceAdminSupportCasePrivateNoStore"];
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["ExperienceAdminSupportCaseErrorResponse"];
            };
        };
    };
    parameters: never;
    requestBodies: never;
    headers: {
        /** @description 事務局内部メモを含むAdmin本人向け応答を共有cacheへ保存しない。 */
        ExperienceAdminSupportCasePrivateNoStore: "private, no-store";
    };
    pathItems: never;
};
export type $defs = Record<string, never>;
export interface operations {
    getAdminExperienceSupportCase: {
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
                    "Cache-Control": components["headers"]["ExperienceAdminSupportCasePrivateNoStore"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ExperienceAdminSupportCaseReadResponse"];
                };
            };
            400: components["responses"]["ExperienceAdminSupportCaseValidationError"];
            401: components["responses"]["ExperienceAdminSupportCaseUnauthorized"];
            403: components["responses"]["ExperienceAdminSupportCaseForbidden"];
            404: components["responses"]["ExperienceAdminSupportCaseNotFound"];
            405: components["responses"]["ExperienceAdminSupportCaseMethodNotAllowed"];
        };
    };
    patchAdminExperienceSupportCase: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                requestId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ExperienceAdminSupportCasePatchRequest"];
            };
        };
        responses: {
            /** @description Updated */
            200: {
                headers: {
                    "Cache-Control": components["headers"]["ExperienceAdminSupportCasePrivateNoStore"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ExperienceAdminSupportCasePatchResponse"];
                };
            };
            400: components["responses"]["ExperienceAdminSupportCaseValidationError"];
            401: components["responses"]["ExperienceAdminSupportCaseUnauthorized"];
            403: components["responses"]["ExperienceAdminSupportCaseForbidden"];
            404: components["responses"]["ExperienceAdminSupportCaseNotFound"];
            405: components["responses"]["ExperienceAdminSupportCaseMethodNotAllowed"];
            409: components["responses"]["ExperienceAdminSupportCaseConflict"];
            503: components["responses"]["ExperienceAdminSupportCaseServiceUnavailable"];
        };
    };
    listAdminExperienceSupportAdmins: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description OK */
            200: {
                headers: {
                    "Cache-Control": components["headers"]["ExperienceAdminSupportCasePrivateNoStore"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ExperienceAdminSupportAdminListResponse"];
                };
            };
            400: components["responses"]["ExperienceAdminSupportCaseValidationError"];
            401: components["responses"]["ExperienceAdminSupportCaseUnauthorized"];
            403: components["responses"]["ExperienceAdminSupportCaseForbidden"];
            405: components["responses"]["ExperienceAdminSupportAdminMethodNotAllowed"];
        };
    };
}
