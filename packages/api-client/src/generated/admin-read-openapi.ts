// このファイルは scripts/gen-types.ts が contract/experience-admin-read-api.openapi.json から生成する。手で編集しない。
// 更新: npm -C packages/api-client run gen:types
export type paths = {
    "/api/admin/experience-bookings": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * platform ADMINが体験予約を横断して読む
         * @description 提供者器の体験予約と通常拠点のEXPERIENCE_SITE体験予約だけを返す。platform ADMIN専用。
         *     全応答は `Cache-Control: private, no-store`。AppConnectの接続・scopeは認証専用契約で後続接続する。
         */
        get: operations["listAdminExperienceBookings"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/admin/experience-bookings/{requestId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * platform ADMINが体験予約詳細を読む
         * @description platform ADMIN専用。Stripe内部IDを返さない。全応答は
         *     `Cache-Control: private, no-store`。
         */
        get: operations["getAdminExperienceBooking"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/admin/experience-bookings/query": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * platform ADMINがJSON本文で体験予約を検索する
         * @description 予約者名・ホスト名などの検索語をrequest URLへ載せない読取経路。
         *     公開Admin画面の検索にはこの経路を使う。GETと同じ対象・cursor・応答で、予約は変更しない。
         *     全応答は `Cache-Control: private, no-store`。
         */
        post: operations["queryAdminExperienceBookings"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/admin/experience-support-notifications": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * platform ADMINが支援対象予約の通知を読む
         * @description 支援ONの予約に属する管理画面内通知。既読はAdmin本人ごとで、全対象の未読件数を返す。
         *     新しい連絡は旅行者からの受信保存経路が未整備のため、この版では生成しない。全応答は `Cache-Control: private, no-store`。
         */
        get: operations["listAdminExperienceSupportNotifications"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/admin/experience-support-notifications/read": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * platform ADMIN本人の通知を既読にする
         * @description 1〜64件を本人の既読にする。未知・対象外IDを1件でも含めれば全件拒否し、再送は最初のreadAtを維持する。
         *     成功時は同じtransactionで既読反映後の全対象未読件数も返す。予約のneedsAttentionや業務状態は変更しない。
         *     全応答は `Cache-Control: private, no-store`。
         */
        post: operations["markAdminExperienceSupportNotificationsRead"];
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
        ExperienceAdminBookingAnswer: {
            /** @enum {string} */
            inputType: "SHORT_TEXT" | "LONG_TEXT" | "SINGLE_SELECT" | "MULTI_SELECT";
            options: components["schemas"]["ExperienceAdminBookingAnswerOption"][];
            prompt: string;
            questionId: string;
            text: string | null;
        };
        ExperienceAdminBookingAnswerOption: {
            id: string;
            label: string;
        };
        ExperienceAdminBookingDetail: {
            adultCount: number;
            adultPriceYen: number;
            answers: components["schemas"]["ExperienceAdminBookingAnswer"][] | null;
            /** Format: date-time */
            approvalDeadlineAt: string | null;
            /** Format: date-time */
            authorizedAt: string | null;
            /** Format: date-time */
            cancelledAt: string | null;
            cancelMessage: string | null;
            cancelReason: string | null;
            childCount: number;
            childPriceYen: number | null;
            /** Format: date-time */
            createdAt: string;
            /** Format: date-time */
            endAt: string;
            guestEmail: string;
            guestName: string;
            headCount: number;
            host: components["schemas"]["ExperienceAdminBookingHost"];
            hostMessages: components["schemas"]["ExperienceAdminBookingHostMessage"][];
            id: string;
            languageSnapshot: string;
            note: string | null;
            occurrenceDate: string;
            offerId: string;
            offerName: string;
            page: {
                title: string;
            };
            pageId: string;
            /** Format: date-time */
            paidAt: string | null;
            refundedYen: number;
            salesChannel: string;
            /** Format: date-time */
            startAt: string;
            status: components["schemas"]["ExperienceAdminBookingStatus"];
            support: components["schemas"]["ExperienceAdminSupportSnapshotRead"];
            totalYen: number;
            /** Format: date-time */
            travelerCancelRequestedAt: string | null;
            unitPriceYen: number;
        };
        ExperienceAdminBookingDetailResponse: {
            booking: components["schemas"]["ExperienceAdminBookingDetail"];
            supportAgreement: {
                agreementRevision: number | null;
                matchesBookingSnapshot: boolean;
                sharedConsultationMemo: string | null;
            };
        };
        ExperienceAdminBookingHost: {
            displayName: string;
            id: string;
            /** @enum {string} */
            kind: "EXPERIENCE_PROVIDER";
            vesselSpotId: string;
        } | {
            displayName: string;
            id: string;
            /** @enum {string} */
            kind: "SPOT";
        };
        ExperienceAdminBookingHostMessage: {
            /** Format: date-time */
            createdAt: string;
            /** @enum {string} */
            deliveryStatus: "QUEUED" | "SENT" | "FAILED" | "UNKNOWN";
            failed: boolean;
            id: string;
            /** Format: date-time */
            sentAt: string | null;
            subject: string;
        };
        ExperienceAdminBookingListItem: {
            /** Format: date-time */
            createdAt: string;
            /** Format: date-time */
            endAt: string;
            experienceTitle: string;
            guestName: string;
            headCount: number;
            host: components["schemas"]["ExperienceAdminBookingHost"];
            id: string;
            needsAttention: boolean;
            occurrenceDate: string;
            offerName: string;
            pageId: string;
            /** Format: date-time */
            startAt: string;
            status: components["schemas"]["ExperienceAdminBookingStatus"];
            support: components["schemas"]["ExperienceAdminSupportSnapshotRead"];
            totalYen: number;
        };
        ExperienceAdminBookingListResponse: {
            bookings: components["schemas"]["ExperienceAdminBookingListItem"][];
            nextCursor: string | null;
        };
        ExperienceAdminBookingQuery: {
            /** @enum {string} */
            attention?: "yes" | "no";
            cursor?: string;
            fromDate?: string;
            hostId?: string;
            hostSearch?: string;
            /** @default 50 */
            limit: number;
            search?: string;
            status?: components["schemas"]["ExperienceAdminBookingStatus"];
            /** @enum {string} */
            support?: "on" | "off" | "legacy";
            toDate?: string;
        };
        /** @enum {string} */
        ExperienceAdminBookingStatus: "PENDING" | "PAYMENT_PENDING" | "PROVISIONAL" | "CONFIRMED" | "DECLINED" | "EXPIRED" | "CANCELLED" | "REFUND_NEEDED";
        ExperienceAdminErrorResponse: {
            error: {
                code: string;
                details: {
                    [key: string]: unknown;
                };
                message: string;
            };
        };
        ExperienceAdminNotification: {
            body: string;
            bookingRequestId: string;
            id: string;
            /** Format: date-time */
            occurredAt: string;
            /** Format: date-time */
            readAt: string | null;
            title: string;
            type: components["schemas"]["ExperienceAdminNotificationType"];
        };
        ExperienceAdminNotificationListResponse: {
            nextCursor: string | null;
            notifications: components["schemas"]["ExperienceAdminNotification"][];
            unreadCount: number;
        };
        ExperienceAdminNotificationReadRequest: {
            notificationIds: string[];
        };
        ExperienceAdminNotificationReadResponse: {
            notifications: components["schemas"]["ExperienceAdminNotificationReadResult"][];
            unreadCount: number;
        };
        ExperienceAdminNotificationReadResult: {
            id: string;
            /** Format: date-time */
            readAt: string;
        };
        /** @enum {string} */
        ExperienceAdminNotificationType: "APPLICATION_RECEIVED" | "BOOKING_CONFIRMED" | "BOOKING_DECLINED" | "BOOKING_EXPIRED" | "BOOKING_CANCELLED" | "REFUND_NEEDED" | "TRAVELER_CANCEL_REQUESTED";
        ExperienceAdminSupportSnapshot: {
            agreementRevision: number;
            /** @enum {integer} */
            baseRateBps: 1000;
            /** Format: date-time */
            consentedAt: string;
            consentedByUserId: string;
            /** @enum {string} */
            consentVersion: "2026-10-23";
            enabled: boolean;
            /** @enum {string} */
            policyVersion: "2026-10-23";
            /** @enum {integer} */
            supportRateBps: 0 | 500;
            /** @enum {integer} */
            totalRateBps: 1000 | 1500;
        };
        ExperienceAdminSupportSnapshotRead: {
            /** @enum {string} */
            kind: "valid";
            normalOperationsAllowed: boolean;
            snapshot: components["schemas"]["ExperienceAdminSupportSnapshot"];
        } | {
            /** @enum {string} */
            kind: "legacy" | "invalid";
            /** @enum {boolean} */
            normalOperationsAllowed: false;
            /** @enum {object|null} */
            snapshot: never | null;
        };
    };
    responses: {
        /** @description platform ADMIN権限が必要 */
        ExperienceAdminForbidden: {
            headers: {
                "Cache-Control": components["headers"]["ExperienceAdminPrivateNoStore"];
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["ExperienceAdminErrorResponse"];
            };
        };
        /** @description 未定義のHTTPメソッド */
        ExperienceAdminMethodNotAllowed: {
            headers: {
                Allow?: "GET" | "POST";
                "Cache-Control": components["headers"]["ExperienceAdminPrivateNoStore"];
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["ExperienceAdminErrorResponse"];
            };
        };
        /** @description 対象が無いか現在の対象scope外 */
        ExperienceAdminNotFound: {
            headers: {
                "Cache-Control": components["headers"]["ExperienceAdminPrivateNoStore"];
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["ExperienceAdminErrorResponse"];
            };
        };
        /** @description 認証が必要 */
        ExperienceAdminUnauthorized: {
            headers: {
                "Cache-Control": components["headers"]["ExperienceAdminPrivateNoStore"];
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["ExperienceAdminErrorResponse"];
            };
        };
        /** @description 入力が不正 */
        ExperienceAdminValidationError: {
            headers: {
                "Cache-Control": components["headers"]["ExperienceAdminPrivateNoStore"];
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["ExperienceAdminErrorResponse"];
            };
        };
    };
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
    listAdminExperienceBookings: {
        parameters: {
            query?: {
                attention?: "yes" | "no";
                cursor?: string;
                fromDate?: string;
                hostId?: string;
                hostSearch?: string;
                limit?: number;
                search?: string;
                status?: components["schemas"]["ExperienceAdminBookingStatus"];
                support?: "on" | "off" | "legacy";
                toDate?: string;
            };
            header?: never;
            path?: never;
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
                    "application/json": components["schemas"]["ExperienceAdminBookingListResponse"];
                };
            };
            400: components["responses"]["ExperienceAdminValidationError"];
            401: components["responses"]["ExperienceAdminUnauthorized"];
            403: components["responses"]["ExperienceAdminForbidden"];
        };
    };
    getAdminExperienceBooking: {
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
                    "application/json": components["schemas"]["ExperienceAdminBookingDetailResponse"];
                };
            };
            401: components["responses"]["ExperienceAdminUnauthorized"];
            403: components["responses"]["ExperienceAdminForbidden"];
            404: components["responses"]["ExperienceAdminNotFound"];
        };
    };
    queryAdminExperienceBookings: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ExperienceAdminBookingQuery"];
            };
        };
        responses: {
            /** @description OK */
            200: {
                headers: {
                    "Cache-Control": components["headers"]["ExperienceAdminPrivateNoStore"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ExperienceAdminBookingListResponse"];
                };
            };
            400: components["responses"]["ExperienceAdminValidationError"];
            401: components["responses"]["ExperienceAdminUnauthorized"];
            403: components["responses"]["ExperienceAdminForbidden"];
        };
    };
    listAdminExperienceSupportNotifications: {
        parameters: {
            query?: {
                cursor?: string;
                limit?: number;
                unread?: "true" | "false";
            };
            header?: never;
            path?: never;
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
                    "application/json": components["schemas"]["ExperienceAdminNotificationListResponse"];
                };
            };
            400: components["responses"]["ExperienceAdminValidationError"];
            401: components["responses"]["ExperienceAdminUnauthorized"];
            403: components["responses"]["ExperienceAdminForbidden"];
            405: components["responses"]["ExperienceAdminMethodNotAllowed"];
        };
    };
    markAdminExperienceSupportNotificationsRead: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ExperienceAdminNotificationReadRequest"];
            };
        };
        responses: {
            /** @description OK */
            200: {
                headers: {
                    "Cache-Control": components["headers"]["ExperienceAdminPrivateNoStore"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ExperienceAdminNotificationReadResponse"];
                };
            };
            400: components["responses"]["ExperienceAdminValidationError"];
            401: components["responses"]["ExperienceAdminUnauthorized"];
            403: components["responses"]["ExperienceAdminForbidden"];
            404: components["responses"]["ExperienceAdminNotFound"];
            405: components["responses"]["ExperienceAdminMethodNotAllowed"];
        };
    };
}
