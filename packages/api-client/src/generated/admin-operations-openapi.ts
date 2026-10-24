// このファイルは scripts/gen-types.ts が contract/experience-admin-operations-api.openapi.json から生成する。手で編集しない。
// 更新: npm -C packages/api-client run gen:types
export type paths = {
    "/api/admin/experience-bookings/{requestId}/approve": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** NIHO事務局として承認待ち予約を承認する */
        post: operations["approveAdminExperienceBooking"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/admin/experience-bookings/{requestId}/cancel": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** NIHO事務局として確定予約を取消・返金する */
        post: operations["cancelAdminExperienceBooking"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/admin/experience-bookings/{requestId}/decline": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** NIHO事務局として承認待ち予約を辞退する */
        post: operations["declineAdminExperienceBooking"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/admin/experience-bookings/{requestId}/message": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** NIHO事務局がホストに代わって予約者へ個別連絡する */
        post: operations["messageAdminExperienceBookingGuest"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/admin/experience-bookings/{requestId}/support-operations": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * platform ADMINが予約の最新操作snapshotと支援操作履歴を読む
         * @description 支援操作専用のCAS revision、現在状態、元の金額、DB/Stripe返金観測、可能操作と直近50件の履歴を返す。
         *     Stripe ID・payload hash・内部メモは返さない。履歴上限とtruncatedを明示し、GETでは決済・返金・送信を開始しない。
         */
        get: operations["getAdminExperienceSupportOperations"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/admin/experience-bookings/{requestId}/support-operations/{operationId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * platform ADMINが既知のoperation IDで保存済み結果を照合する
         * @description 予約IDとoperation IDの両方を照合する。未発見を未実行・確実な失敗とは断定しない。
         */
        get: operations["getAdminExperienceSupportOperation"];
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
        ExperienceAdminApproveRequest: {
            expectedRefundedYen: number;
            expectedRevision: number;
            /** @enum {string} */
            expectedStatus: "PROVISIONAL";
            expectedTotalYen: number;
            /** Format: uuid */
            operationId: string;
            /** @enum {string} */
            reasonCode: "HOST_CONFIRMED" | "SUPPORT_REVIEWED";
        };
        ExperienceAdminCancelRequest: {
            expectedProviderRefundedYen: number;
            expectedRefundAmountYen: number;
            expectedRefundedYen: number;
            expectedRevision: number;
            /** @enum {string} */
            expectedStatus: "CONFIRMED" | "REFUND_NEEDED";
            expectedTotalYen: number;
            message: string;
            /** Format: uuid */
            operationId: string;
            /** @enum {string} */
            reasonCode: "HOST_CANNOT_HOST" | "GUEST_REQUEST" | "OTHER";
            /** @enum {string} */
            refund: "FULL" | "HALF" | "NONE";
        };
        ExperienceAdminDeclineRequest: {
            expectedRefundedYen: number;
            expectedRevision: number;
            /** @enum {string} */
            expectedStatus: "PROVISIONAL";
            expectedTotalYen: number;
            /** Format: uuid */
            operationId: string;
            /** @enum {string} */
            reasonCode: "HOST_CANNOT_HOST" | "OTHER";
        };
        ExperienceAdminMessageRequest: {
            body: string;
            expectedRefundedYen: number;
            expectedRevision: number;
            /** @enum {string} */
            expectedStatus: "PROVISIONAL" | "CONFIRMED" | "REFUND_NEEDED" | "CANCELLED";
            expectedTotalYen: number;
            /** Format: uuid */
            operationId: string;
            /** @enum {string} */
            reasonCode: "BOOKING_DETAILS" | "SCHEDULE_COORDINATION" | "OTHER";
            subject: string;
        };
        ExperienceAdminProviderRefundObservation: {
            /** Format: date-time */
            observedAt: string;
            refundedYen: number | null;
            /** @enum {string} */
            status: "KNOWN" | "NOT_APPLICABLE" | "UNAVAILABLE";
        };
        ExperienceAdminSupportOperation: {
            /** @enum {string} */
            action: "APPROVE" | "DECLINE" | "CANCEL" | "MESSAGE";
            /** @enum {string} */
            actorKind: "NIHO_SUPPORT";
            bookingRequestId: string;
            /** Format: date-time */
            completedAt: string | null;
            /** Format: date-time */
            createdAt: string;
            expectedProviderRefundedYen: number | null;
            expectedRefundedYen: number;
            expectedRevision: number;
            expectedStatus: string;
            expectedTotalYen: number;
            /** Format: date-time */
            firstExternalAttemptAt: string | null;
            /** Format: date-time */
            lastReconciledAt: string | null;
            message: components["schemas"]["ExperienceAdminSupportOperationMessage"];
            /** Format: uuid */
            operationId: string;
            reasonCode: string | null;
            requestedRefundAmountYen: number | null;
            resultCode: string | null;
            resultRefundedYen: number | null;
            resultStatus: string | null;
            /** @description 同じIDとpayloadを保持するクライアントだけが再送できる。write停止・SMTP曖昧結果・24時間到達後はfalse。 */
            retryAllowed: boolean;
            /** @enum {string} */
            state: "ACCEPTED" | "PROCESSING" | "UNKNOWN" | "SUCCEEDED" | "REJECTED" | "FAILED";
            /** Format: date-time */
            updatedAt: string;
        };
        ExperienceAdminSupportOperationBookingSnapshot: {
            actions: {
                approve: components["schemas"]["ExperienceAdminSupportOperationCapability"];
                cancel: components["schemas"]["ExperienceAdminSupportOperationCapability"];
                decline: components["schemas"]["ExperienceAdminSupportOperationCapability"];
                message: components["schemas"]["ExperienceAdminSupportOperationCapability"];
            };
            /** Format: date-time */
            approvalDeadlineAt: string | null;
            bookingRequestId: string;
            /** Format: date-time */
            endAt: string;
            guest: {
                displayName: string;
            };
            host: {
                displayName: string;
                id: string;
                /** @enum {string} */
                kind: "SPOT";
            } | {
                displayName: string;
                id: string;
                /** @enum {string} */
                kind: "EXPERIENCE_PROVIDER";
                vesselSpotId: string;
            };
            /** Format: date */
            occurrenceDate: string;
            providerRefund: components["schemas"]["ExperienceAdminProviderRefundObservation"];
            refundedYen: number;
            refundOptions: {
                /** @enum {string} */
                choice: "FULL" | "HALF" | "NONE";
                refundAmountYen: number;
                resultRefundedYen: number;
            }[];
            revision: number;
            /** Format: date-time */
            startAt: string;
            status: string;
            totalYen: number;
            /** Format: date-time */
            updatedAt: string;
        };
        ExperienceAdminSupportOperationCapability: {
            allowed: boolean;
            reason: string | null;
        };
        ExperienceAdminSupportOperationDetailResponse: {
            operation: components["schemas"]["ExperienceAdminSupportOperation"];
        };
        ExperienceAdminSupportOperationError: {
            error: {
                code: string;
                details: {
                    [key: string]: unknown;
                };
                message: string;
            };
        };
        ExperienceAdminSupportOperationMessage: {
            body: string | null;
            /** @enum {string|null} */
            deliveryStatus: "PENDING" | "SENT" | "FAILED" | "UNKNOWN" | null;
            messageId: string | null;
            retained: boolean;
            subject: string | null;
        } | null;
        ExperienceAdminSupportOperationSnapshotResponse: {
            booking: components["schemas"]["ExperienceAdminSupportOperationBookingSnapshot"];
            history: {
                /** @enum {integer} */
                limit: 50;
                truncated: boolean;
            };
            operations: components["schemas"]["ExperienceAdminSupportOperation"][];
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
    approveAdminExperienceBooking: {
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
                "application/json": components["schemas"]["ExperienceAdminApproveRequest"];
            };
        };
        responses: {
            /** @description Completed */
            200: {
                headers: {
                    "Cache-Control": components["headers"]["ExperienceAdminPrivateNoStore"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ExperienceAdminSupportOperationDetailResponse"];
                };
            };
            /** @description Accepted or result unknown */
            202: {
                headers: {
                    "Cache-Control": components["headers"]["ExperienceAdminPrivateNoStore"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ExperienceAdminSupportOperationDetailResponse"];
                };
            };
            /** @description Invalid */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ExperienceAdminSupportOperationError"];
                };
            };
            /** @description Conflict */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ExperienceAdminSupportOperationError"];
                };
            };
            /** @description Unavailable */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ExperienceAdminSupportOperationError"];
                };
            };
        };
    };
    cancelAdminExperienceBooking: {
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
                "application/json": components["schemas"]["ExperienceAdminCancelRequest"];
            };
        };
        responses: {
            /** @description Completed */
            200: {
                headers: {
                    "Cache-Control": components["headers"]["ExperienceAdminPrivateNoStore"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ExperienceAdminSupportOperationDetailResponse"];
                };
            };
            /** @description Accepted or result unknown */
            202: {
                headers: {
                    "Cache-Control": components["headers"]["ExperienceAdminPrivateNoStore"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ExperienceAdminSupportOperationDetailResponse"];
                };
            };
            /** @description Invalid */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ExperienceAdminSupportOperationError"];
                };
            };
            /** @description Conflict */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ExperienceAdminSupportOperationError"];
                };
            };
            /** @description Unavailable */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ExperienceAdminSupportOperationError"];
                };
            };
        };
    };
    declineAdminExperienceBooking: {
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
                "application/json": components["schemas"]["ExperienceAdminDeclineRequest"];
            };
        };
        responses: {
            /** @description Completed */
            200: {
                headers: {
                    "Cache-Control": components["headers"]["ExperienceAdminPrivateNoStore"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ExperienceAdminSupportOperationDetailResponse"];
                };
            };
            /** @description Accepted or result unknown */
            202: {
                headers: {
                    "Cache-Control": components["headers"]["ExperienceAdminPrivateNoStore"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ExperienceAdminSupportOperationDetailResponse"];
                };
            };
            /** @description Invalid */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ExperienceAdminSupportOperationError"];
                };
            };
            /** @description Conflict */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ExperienceAdminSupportOperationError"];
                };
            };
            /** @description Unavailable */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ExperienceAdminSupportOperationError"];
                };
            };
        };
    };
    messageAdminExperienceBookingGuest: {
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
                "application/json": components["schemas"]["ExperienceAdminMessageRequest"];
            };
        };
        responses: {
            /** @description Sent */
            200: {
                headers: {
                    "Cache-Control": components["headers"]["ExperienceAdminPrivateNoStore"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ExperienceAdminSupportOperationDetailResponse"];
                };
            };
            /** @description Accepted or result unknown */
            202: {
                headers: {
                    "Cache-Control": components["headers"]["ExperienceAdminPrivateNoStore"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ExperienceAdminSupportOperationDetailResponse"];
                };
            };
            /** @description Invalid */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ExperienceAdminSupportOperationError"];
                };
            };
            /** @description Conflict */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ExperienceAdminSupportOperationError"];
                };
            };
            /** @description Unavailable */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ExperienceAdminSupportOperationError"];
                };
            };
        };
    };
    getAdminExperienceSupportOperations: {
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
                    "application/json": components["schemas"]["ExperienceAdminSupportOperationSnapshotResponse"];
                };
            };
            /** @description Invalid */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ExperienceAdminSupportOperationError"];
                };
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ExperienceAdminSupportOperationError"];
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ExperienceAdminSupportOperationError"];
                };
            };
            /** @description Not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ExperienceAdminSupportOperationError"];
                };
            };
        };
    };
    getAdminExperienceSupportOperation: {
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
                    "application/json": components["schemas"]["ExperienceAdminSupportOperationDetailResponse"];
                };
            };
            /** @description Not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ExperienceAdminSupportOperationError"];
                };
            };
        };
    };
}
