// このファイルは scripts/gen-types.ts が contract/experience-host-api.openapi.json から生成する。手で編集しない。
// 更新: npm -C packages/api-client run gen:types
export type paths = {
    "/api/auth/app-connections/{connectionId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /**
         * Mac アプリの接続を解除する
         * @description 自分の接続だけ（他人のは 404）。アプリの接続由来の token は自分の接続しか解除できない（他は 403 `app_connection_foreign`）。
         *     アプリ自身のログアウトは `?reason=logout`（`revokedReason: LOGOUT`。それ以外は `USER_REVOKED`）。既に失効なら 204 のまま。
         *     アプリ自身が解除した接続の token での再送は、認証で 401 `app_connection_revoked`（アプリは解除済みとして扱う）。
         *     Firebase の `revokeRefreshTokens` は呼ばない（接続の記録で個別に失効し、API の認証と `refresh` で照らす）。
         */
        delete: operations["deleteAuthAppConnection"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/auth/me": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * 自分のユーザー情報・所属情報を取得
         * @description `niho_app_client=niho-experience` の接続 token では、表示名と顔写真だけを返す。
         *     所属・連絡先・オンボーディング回答などは含まず、クエリ付き要求は 403 で拒否する。
         *     `niho-camera` / `niho-docs` の接続 token では、canonical User.id・表示名・handle・顔写真だけを返す。
         *     Macクライアントの64KiB上限内で本人照合できるよう所属情報を含まず、クエリ付き要求は同様に403にする。
         */
        get: operations["getAuthMe"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/experience-host/identity": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Experience BFF向けに現在のNIHOログイン本人を確認する
         * @description `niho-experience` の現在有効なAppConnection bearerとExperience runtime service accountのGoogle ID tokenを両方要求する。
         *     NIHO `User.id`だけを安定IDとして返す。User削除・LOGIN以外・Person停止/統合・Firebase無効・Firebase token失効・AppConnection失効/期限切れは認証失敗にする。
         *     Firebase/DB/設定またはGoogle ID token検証の一時障害は503でfail closed。全応答no-store。queryは受理しない。
         *     Experience側のprovider権限・予約・決済は判定しない。
         */
        get: operations["getExperienceHostIdentity"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/experience-host/legacy-providers/{legacyProviderId}/connect-account": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * NIHO旧providerのConnect参照・現在readiness・再利用同意を読む
         * @description 現在activeなNIHO accountとExperience runtime service accountの両方を要求し、pathのlegacyProviderIdが現在callerのNIHO ownerUserIdと一致する場合だけ返す。
         *     responseはBFF内部専用。stripeAccountIdをブラウザーへ渡さない。readinessはStripeのlive Accountをread-onlyで取得し、Stripe・DB障害は古いsnapshotへfallbackせず503にする。
         *     paymentReuseConsent.acceptedは現行consent versionとconsentedAtの両方が存在するときだけtrue。provider権限やConnect操作は実行しない。queryは受理しない。
         */
        get: operations["getExperienceHostLegacyConnectAccount"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/experience-providers/{providerId}/bookings": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description 提供者の ID（`ExperienceProvider.id`） */
                providerId: components["parameters"]["ExperienceProviderId"];
            };
            cookie?: never;
        };
        /**
         * 提供者の予約一覧を読む
         * @description OWNER / 有効な COHOST（platform ADMIN）が、提供者の専用器に属する体験の予約だけを扱う。providerId・pageId・requestId は同じ提供者に結び、他の提供者やページは 404。応答は private, no-store。
         */
        get: operations["listExperienceProviderBookings"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/experience-providers/{providerId}/bookings/{requestId}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description 提供者の ID（`ExperienceProvider.id`） */
                providerId: components["parameters"]["ExperienceProviderId"];
                requestId: components["parameters"]["ExperienceHostBookingRequestId"];
            };
            cookie?: never;
        };
        /**
         * 提供者の予約詳細を読む
         * @description OWNER / 有効な COHOST（platform ADMIN）が、提供者の専用器に属する体験の予約だけを扱う。providerId・pageId・requestId は同じ提供者に結び、他の提供者やページは 404。応答は private, no-store。
         */
        get: operations["getExperienceProviderBooking"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/experience-providers/{providerId}/pages/{pageId}/bookings/{requestId}/approve": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description 企画ページの ID（SpotCampaignPage.id） */
                pageId: components["parameters"]["CampaignPageId"];
                /** @description 提供者の ID（`ExperienceProvider.id`） */
                providerId: components["parameters"]["ExperienceProviderId"];
                requestId: components["parameters"]["ExperienceHostBookingRequestId"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * 予約を承認する
         * @description OWNER / 有効な COHOST（platform ADMIN）が、提供者の専用器に属する体験の予約だけを扱う。providerId・pageId・requestId は同じ提供者に結び、他の提供者やページは 404。応答は private, no-store。
         */
        post: operations["approveExperienceProviderBooking"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/experience-providers/{providerId}/pages/{pageId}/bookings/{requestId}/cancel": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description 企画ページの ID（SpotCampaignPage.id） */
                pageId: components["parameters"]["CampaignPageId"];
                /** @description 提供者の ID（`ExperienceProvider.id`） */
                providerId: components["parameters"]["ExperienceProviderId"];
                requestId: components["parameters"]["ExperienceHostBookingRequestId"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * 予約を取り消し返金する
         * @description OWNER / 有効な COHOST（platform ADMIN）が、提供者の専用器に属する体験の予約だけを扱う。providerId・pageId・requestId は同じ提供者に結び、他の提供者やページは 404。応答は private, no-store。
         */
        post: operations["cancelExperienceProviderBooking"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/experience-providers/{providerId}/pages/{pageId}/bookings/{requestId}/decline": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description 企画ページの ID（SpotCampaignPage.id） */
                pageId: components["parameters"]["CampaignPageId"];
                /** @description 提供者の ID（`ExperienceProvider.id`） */
                providerId: components["parameters"]["ExperienceProviderId"];
                requestId: components["parameters"]["ExperienceHostBookingRequestId"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * 予約を辞退する
         * @description OWNER / 有効な COHOST（platform ADMIN）が、提供者の専用器に属する体験の予約だけを扱う。providerId・pageId・requestId は同じ提供者に結び、他の提供者やページは 404。応答は private, no-store。
         */
        post: operations["declineExperienceProviderBooking"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/experience-providers/{providerId}/pages/{pageId}/bookings/{requestId}/message": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description 企画ページの ID（SpotCampaignPage.id） */
                pageId: components["parameters"]["CampaignPageId"];
                /** @description 提供者の ID（`ExperienceProvider.id`） */
                providerId: components["parameters"]["ExperienceProviderId"];
                requestId: components["parameters"]["ExperienceHostBookingRequestId"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * 予約した旅行者へメッセージを送る
         * @description OWNER / 有効な COHOST（platform ADMIN）が、提供者の専用器に属する体験の予約だけを扱う。providerId・pageId・requestId は同じ提供者に結び、他の提供者やページは 404。応答は private, no-store。
         */
        post: operations["messageExperienceProviderGuest"];
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
        /**
         * @description 体験サイトのホストの画面が `GET /api/auth/me` から受け取る表示名と顔写真。
         *     応答の正は `AuthMeExperienceProfileResponse`。ホストの契約の書き出しでは、`getAuthMe` の 200 の
         *     schema をこれに置き換える。項目を足すときは実際の応答と一致することを contracts の test が見る。
         */
        ExperienceHostAuthMe: {
            user: {
                displayName: string | null;
            };
            /** @description プロフィールの顔写真（短命の署名つき URL）。未設定は null */
            userIconImage: {
                /** Format: date-time */
                expiresAt: string;
                signedUrl: string;
            } | null;
        };
        ExperienceHostBookingAnswerSnapshot: {
            /** @enum {string} */
            inputType: "SHORT_TEXT" | "LONG_TEXT" | "SINGLE_SELECT" | "MULTI_SELECT";
            options: components["schemas"]["ExperienceHostBookingQuestionOption"][];
            prompt: string;
            questionId: string;
            text: string | null;
        };
        ExperienceHostBookingAnswerSnapshots: components["schemas"]["ExperienceHostBookingAnswerSnapshot"][] | null;
        ExperienceHostBookingBookingDetail: {
            adultCount: number;
            adultPriceYen: number;
            answers: components["schemas"]["ExperienceHostBookingAnswerSnapshots"];
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
            guestMessages: components["schemas"]["ExperienceHostBookingGuestMessage"][];
            guestName: string;
            headCount: number;
            hostMessages: components["schemas"]["ExperienceHostBookingHostMessage"][];
            id: string;
            languageSnapshot: string;
            note: string | null;
            /** Format: date */
            occurrenceDate: string;
            offerId: string;
            offerName: string;
            page: components["schemas"]["ExperienceHostBookingPageTitle"];
            pageId: string;
            /** Format: date-time */
            paidAt: string | null;
            refundedYen: number;
            salesChannel: string;
            /** Format: date-time */
            startAt: string;
            status: components["schemas"]["ExperienceHostBookingKnownBookingStatus"];
            totalYen: number;
            /** Format: date-time */
            travelerCancelRequestedAt: string | null;
            unitPriceYen: number;
        };
        ExperienceHostBookingBookingDetailResponse: {
            booking: components["schemas"]["ExperienceHostBookingBookingDetail"];
            sender: components["schemas"]["ExperienceHostBookingSender"];
        };
        ExperienceHostBookingBookingListItem: {
            adultCount: number;
            /** Format: date-time */
            authorizedAt: string | null;
            /** Format: date-time */
            cancelledAt: string | null;
            childCount: number;
            /** Format: date-time */
            createdAt: string;
            /** Format: date-time */
            endAt: string;
            experienceSiteListingId: string | null;
            guestEmail: string;
            guestName: string;
            headCount: number;
            id: string;
            note: string | null;
            /** Format: date */
            occurrenceDate: string;
            offerId: string;
            offerNameSnapshot: string;
            page: components["schemas"]["ExperienceHostBookingPageTitle"];
            pageId: string;
            /** Format: date-time */
            paidAt: string | null;
            questionAnswersJson: components["schemas"]["ExperienceHostBookingAnswerSnapshots"];
            refundedYen: number;
            salesChannel: components["schemas"]["ExperienceHostBookingSalesChannel"];
            sellerDisplayNameSnapshot: string | null;
            spotId: string;
            /** Format: date-time */
            startAt: string;
            status: components["schemas"]["ExperienceHostBookingProjectedBookingStatus"];
            totalYenSnapshot: number;
        };
        ExperienceHostBookingBookingListResponse: {
            bookings: components["schemas"]["ExperienceHostBookingBookingListItem"][];
            nextCursor: string | null;
        };
        ExperienceHostBookingBookingStatusResponse: {
            status: components["schemas"]["ExperienceHostBookingKnownBookingStatus"];
        };
        ExperienceHostBookingCancelBookingInput: {
            message: string;
            /** @enum {string} */
            reason: "HOST_CANNOT_HOST" | "GUEST_REQUEST" | "OTHER";
            /** @enum {string} */
            refund: "FULL" | "HALF" | "NONE";
        };
        ExperienceHostBookingCancelBookingResponse: {
            refundedYen: number;
            status: components["schemas"]["ExperienceHostBookingKnownBookingStatus"];
        };
        ExperienceHostBookingGuestMessage: {
            body: string;
            /** Format: date-time */
            createdAt: string;
            id: string;
        };
        ExperienceHostBookingHostMessage: {
            body: string | null;
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
        /** @enum {string} */
        ExperienceHostBookingKnownBookingStatus: "PENDING" | "PAYMENT_PENDING" | "PROVISIONAL" | "CONFIRMED" | "DECLINED" | "EXPIRED" | "CANCELLED" | "REFUND_NEEDED";
        ExperienceHostBookingMessageInput: {
            body: string;
            subject: string;
        };
        ExperienceHostBookingMessageReceipt: {
            /** Format: date-time */
            createdAt: string;
            id: string;
            /** Format: date-time */
            sentAt: string | null;
            subject: string;
        };
        ExperienceHostBookingMessageResponse: {
            message: components["schemas"]["ExperienceHostBookingMessageReceipt"];
        };
        ExperienceHostBookingPageTitle: {
            title: string;
        };
        /** @enum {string} */
        ExperienceHostBookingProjectedBookingStatus: "PENDING" | "PAYMENT_PENDING" | "PROVISIONAL" | "CONFIRMED" | "DECLINED" | "EXPIRED" | "CANCELLED" | "REFUND_NEEDED" | "UNKNOWN";
        ExperienceHostBookingQuestionOption: {
            id: string;
            label: string;
        };
        /** @enum {string|null} */
        ExperienceHostBookingSalesChannel: "NIHO_PAGE" | "EMBED" | "EXPERIENCE_SITE" | null;
        ExperienceHostBookingSender: {
            displayName: string;
            replyToEmails: string[];
        };
        ExperienceHostError: {
            code: components["schemas"]["ExperienceHostErrorCode"];
            details: components["schemas"]["ExperienceHostErrorDetails"];
            /** @description 人が読む説明（日本語）。画面の分岐には使わない */
            message: string;
            /** @description 問い合わせ用の ID。400 は null、それ以外は値がある（`details.supportId` と同じ） */
            supportId: string | null;
        };
        /**
         * @description status との対応: 400 `VALIDATION_ERROR`・401 `UNAUTHORIZED`・403 `FORBIDDEN` / `ACCOUNT_DELETED`（退会済みのアカウント）・
         *     404 `NOT_FOUND`・409 `CONFLICT`・422 `UNPROCESSABLE_ENTITY`・429 `RATE_LIMITED`・503 `SERVICE_UNAVAILABLE`。
         * @enum {string}
         */
        ExperienceHostErrorCode: "VALIDATION_ERROR" | "UNAUTHORIZED" | "FORBIDDEN" | "ACCOUNT_DELETED" | "NOT_FOUND" | "CONFLICT" | "UNPROCESSABLE_ENTITY" | "RATE_LIMITED" | "SERVICE_UNAVAILABLE";
        /**
         * @description 失敗の詳しい中身。理由ごとに項目の組が決まっていて、下のどれか 1 つの形になる。400 は `supportId` と `requestId` を持たず、
         *     それ以外の status は問い合わせ用の `supportId` と `requestId` を必ず持つ。
         */
        ExperienceHostErrorDetails: Record<string, never> | {
            field: string;
            reason: components["schemas"]["ExperienceHostErrorReason"];
        } | {
            requestId: string;
            supportId: string;
        } | {
            reason: components["schemas"]["ExperienceHostErrorReason"];
            requestId: string;
            supportId: string;
        } | {
            field: string;
            reason: components["schemas"]["ExperienceHostErrorReason"];
            requestId: string;
            supportId: string;
        } | {
            field: string;
            reason: components["schemas"]["ExperienceHostErrorReason"];
            requestId: string;
            slug: string;
            supportId: string;
        } | {
            pageId: string;
            reason: components["schemas"]["ExperienceHostErrorReason"];
            requestId: string;
            supportId: string;
        } | {
            blockers: components["schemas"]["SpotCampaignPagePublishBlocker"][];
            reason: components["schemas"]["ExperienceHostErrorReason"];
            requestId: string;
            supportId: string;
        };
        /**
         * @description `error.details.reason` の値。どの operation がどの理由を返すかは operation の説明に書く。
         *     - 認証（どの operation でも）: 401 `invalid_token` / `anonymous_provider_not_allowed` / `directory_only_account` / `app_connect_disabled` /
         *       `app_connection_revoked`（接続が解除された。ログインし直す）、403 `app_client_scope`（この接続では呼べない API）、
         *       503 `auth_user_lookup_failed` / `app_connection_lookup_failed`（一時的な失敗）。`GET /api/auth/me` は 401 `user_not_found` も返す。
         *     - 提供者・受取口座・集合場所: `PROVIDER_*`。体験ページ: `PAGE_*`。体験サイトへの掲載: `EXPERIENCE_LISTING_*`。
         *     - 写真: 403 `upload_expired`、404 `object_missing`、503 `uploads_disabled` / `object_lookup_failed` / `signing_circuit_open` /
         *       `signing_transient_failure`。
         *     - 予約前の質問の返信の下書き: 503 `TRANSLATION_UNAVAILABLE`（翻訳が使えない・失敗した。英語を自分で書いて送れる）。
         * @enum {string}
         */
        ExperienceHostErrorReason: "invalid_token" | "anonymous_provider_not_allowed" | "directory_only_account" | "app_connect_disabled" | "app_connection_revoked" | "user_not_found" | "app_client_scope" | "auth_user_lookup_failed" | "app_connection_lookup_failed" | "PROVIDER_CONSENT_OUTDATED" | "PROVIDER_EMAIL_REQUIRED" | "PROVIDER_REVIEW_STATE_CONFLICT" | "PROVIDER_NOT_FOUND" | "PROVIDER_PAYMENT_SOURCE_FORBIDDEN" | "PROVIDER_PAYMENT_LOCKED" | "PROVIDER_PAYMENT_CONSENT_OUTDATED" | "PROVIDER_PAYMENT_SOURCE_NOT_READY" | "PROVIDER_CONNECT_UNAVAILABLE" | "PROVIDER_PAYMENT_SHARED_ACCOUNT" | "PROVIDER_PAYMENT_NOT_CONNECTED" | "PROVIDER_PAGE_NOT_FOUND" | "PROVIDER_PAGE_CONFLICT" | "PAGE_REQUEST_INVALID" | "PAGE_TITLE_INVALID" | "PAGE_SLUG_INVALID" | "PAGE_CONTENT_INVALID" | "PAGE_PHOTOS_INVALID" | "PAGE_OFFER_INVALID" | "PAGE_OFFER_QUESTIONS_INVALID" | "PAGE_NOT_FOUND" | "PAGE_SLUG_TAKEN" | "PAGE_SLUG_LOCKED" | "PAGE_UPDATED" | "PAGE_OFFER_HAS_BOOKINGS" | "PAGE_NOT_PUBLISHED" | "PAGE_DELETE_PUBLISHED" | "PAGE_DELETE_HAS_BOOKINGS" | "PAGE_PUBLISH_BLOCKED" | "EXPERIENCE_LISTING_NOT_FOUND" | "EXPERIENCE_LISTING_CONSENT_OUTDATED" | "EXPERIENCE_LISTING_PAGE_NOT_ELIGIBLE" | "EXPERIENCE_LISTING_STATUS_CONFLICT" | "uploads_disabled" | "upload_expired" | "object_missing" | "object_lookup_failed" | "signing_circuit_open" | "signing_transient_failure" | "TRANSLATION_UNAVAILABLE" | "PAGE_BOOKING_NOT_FOUND" | "PAGE_BOOKING_CANCEL_INVALID" | "PAGE_BOOKING_REFUND_REQUIRED" | "PAGE_BOOKING_REFUND_UNAVAILABLE" | "PAGE_BOOKING_ALREADY_CANCELLED" | "PAGE_BOOKING_NOT_CANCELLABLE" | "PAGE_BOOKING_APPROVAL_UNAVAILABLE" | "PAGE_BOOKING_NOT_PENDING_APPROVAL" | "PAGE_BOOKING_APPROVAL_EXPIRED" | "PAGE_BOOKING_PAYMENT_UNAVAILABLE" | "PAGE_BOOKING_CONFIRMATION_PENDING" | "PAGE_BOOKING_DECLINE_UNAVAILABLE" | "PAGE_BOOKING_CAPTURED" | "PAGE_BOOKING_MESSAGE_INVALID" | "PAGE_BOOKING_MESSAGE_UNDELIVERABLE";
        /**
         * @description ホストの API（NIHO本人・旧Connect・旧予約の投影と `GET /api/auth/me`）の失敗の本文。各 operation に書いた status の本文だけを約束する
         *     （書いていない status の 429・500 などは共通の層が返し、この形とは限らない）。画面は `error.code` と `error.details.reason` で分ける。
         */
        ExperienceHostErrorResponse: {
            error: components["schemas"]["ExperienceHostError"];
        };
        /** @description 現在activeなNIHO LOGIN accountの安定ID。Experienceのroleや予約権限を含まない。 */
        ExperienceHostIdentityResponse: {
            /** @enum {string} */
            accountStatus: "ACTIVE";
            nihoUserId: string;
        };
        /** @description BFF内でのみ使う旧NIHO providerのConnect参照。Stripe account IDをブラウザーへ返さない。 */
        ExperienceHostLegacyConnectAccountResponse: {
            legacyProviderId: string;
            paymentReuseConsent: components["schemas"]["ExperienceHostPaymentReuseConsent"];
            readiness: {
                ready: boolean;
                reason: components["schemas"]["ExperienceProviderPaymentReadinessReason"];
            };
            /** @description 旧Connect accountの参照。BFF内部専用で、Experienceのブラウザーへは渡さない。 */
            stripeAccountId: string | null;
        };
        /** @description NIHOが保存する現行Connect口座再利用同意のprojection。acceptedは現行版と同意時刻がある場合だけtrue。 */
        ExperienceHostPaymentReuseConsent: {
            accepted: boolean;
            /** Format: date-time */
            consentedAt: string | null;
            version: string | null;
        };
        /**
         * @description 受取口座の準備の状態。`NOT_CONNECTED`（口座が無い）・`VERIFICATION_REQUIRED`（本人確認・提出が済んでいない）・
         *     `CHARGES_DISABLED`（決済を受けられない）・`PAYOUTS_DISABLED`（入金を受けられない）・`RESTRICTED`（制限・停止・設定の不整合）・`READY`。
         * @enum {string}
         */
        ExperienceProviderPaymentReadinessReason: "NOT_CONNECTED" | "VERIFICATION_REQUIRED" | "CHARGES_DISABLED" | "PAYOUTS_DISABLED" | "RESTRICTED" | "READY";
        /**
         * @description 公開を止める理由。PRICE_BELOW_MINIMUM = 料金が Stripe の JPY の最低額（50 円）未満、
         *     STRIPE_NOT_READY = 拠点の都度決済（Stripe Connect）の受け取り準備ができていない、OPS_EMAIL_REQUIRED = 拠点の運用通知メールが空。
         * @enum {string}
         */
        SpotCampaignPagePublishBlocker: "TITLE_REQUIRED" | "COVER_REQUIRED" | "OFFER_PRICE_REQUIRED" | "PRICE_BELOW_MINIMUM" | "OFFER_CAPACITY_REQUIRED" | "OFFER_WEEKDAYS_REQUIRED" | "OFFER_START_REQUIRED" | "OFFER_DURATION_REQUIRED" | "OFFER_ACTIVE_REQUIRED" | "OFFER_SCHEDULE_CONFLICT" | "OFFER_ZONE_INVALID" | "STRIPE_NOT_READY" | "OPS_EMAIL_REQUIRED";
    };
    responses: {
        /** @description 入力の形が違う（`VALIDATION_ERROR`） */
        ExperienceHostBadRequest: {
            headers: {
                "X-Request-Id": components["headers"]["XRequestId"];
                "X-Trace-Id": components["headers"]["XTraceId"];
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["ExperienceHostErrorResponse"];
            };
        };
        /** @description 今の状態ではできない・別の操作と重なった（`CONFLICT`） */
        ExperienceHostConflict: {
            headers: {
                "X-Request-Id": components["headers"]["XRequestId"];
                "X-Trace-Id": components["headers"]["XTraceId"];
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["ExperienceHostErrorResponse"];
            };
        };
        /** @description この操作はできない（`FORBIDDEN`）・退会済みのアカウント（`ACCOUNT_DELETED`） */
        ExperienceHostForbidden: {
            headers: {
                "X-Request-Id": components["headers"]["XRequestId"];
                "X-Trace-Id": components["headers"]["XTraceId"];
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["ExperienceHostErrorResponse"];
            };
        };
        /** @description 見つからない・権限が無い（`NOT_FOUND`。区別しない） */
        ExperienceHostNotFound: {
            headers: {
                "X-Request-Id": components["headers"]["XRequestId"];
                "X-Trace-Id": components["headers"]["XTraceId"];
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["ExperienceHostErrorResponse"];
            };
        };
        /** @description 現在状態を確認できないため要求を実行しない（`SERVICE_UNAVAILABLE`） */
        ExperienceHostServiceUnavailable: {
            headers: {
                "X-Request-Id": components["headers"]["XRequestId"];
                "X-Trace-Id": components["headers"]["XTraceId"];
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["ExperienceHostErrorResponse"];
            };
        };
        /** @description ログインが要る・ログインが切れた（`UNAUTHORIZED`） */
        ExperienceHostUnauthorized: {
            headers: {
                "X-Request-Id": components["headers"]["XRequestId"];
                "X-Trace-Id": components["headers"]["XTraceId"];
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["ExperienceHostErrorResponse"];
            };
        };
    };
    parameters: {
        /** @description 企画ページの ID（SpotCampaignPage.id） */
        CampaignPageId: string;
        ExperienceHostBookingRequestId: string;
        /** @description 提供者の ID（`ExperienceProvider.id`） */
        ExperienceProviderId: string;
    };
    requestBodies: never;
    headers: {
        /**
         * @description API request correlation id.
         *     vX: API は全レスポンスで `X-Request-Id` を返す（client が付与した値を echo するか、server が生成）。
         */
        XRequestId: string;
        /**
         * @description Trace id for correlating Cloud Logging / Cloud Trace.
         *     vX: API は全レスポンスで `X-Trace-Id` を返す（32 hex を想定）。
         */
        XTraceId: string;
    };
    pathItems: never;
};
export type $defs = Record<string, never>;
export interface operations {
    deleteAuthAppConnection: {
        parameters: {
            query?: {
                reason?: "logout";
            };
            header?: never;
            path: {
                connectionId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description 解除した（冪等） */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            401: components["responses"]["ExperienceHostUnauthorized"];
            403: components["responses"]["ExperienceHostForbidden"];
            404: components["responses"]["ExperienceHostNotFound"];
        };
    };
    getAuthMe: {
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
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ExperienceHostAuthMe"];
                };
            };
            401: components["responses"]["ExperienceHostUnauthorized"];
            403: components["responses"]["ExperienceHostForbidden"];
        };
    };
    getExperienceHostIdentity: {
        parameters: {
            query?: never;
            header: {
                /** @description Experience runtime専用service accountのGoogle署名ID token。serverのみが送る。 */
                "X-NIHO-Experience-Service-Id-Token": string;
            };
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description 現在activeなNIHO login account */
            200: {
                headers: {
                    "Cache-Control"?: "private, no-store";
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ExperienceHostIdentityResponse"];
                };
            };
            401: components["responses"]["ExperienceHostUnauthorized"];
            403: components["responses"]["ExperienceHostForbidden"];
            404: components["responses"]["ExperienceHostNotFound"];
            503: components["responses"]["ExperienceHostServiceUnavailable"];
        };
    };
    getExperienceHostLegacyConnectAccount: {
        parameters: {
            query?: never;
            header: {
                /** @description Experience runtime専用service accountのGoogle署名ID token。serverのみが送る。 */
                "X-NIHO-Experience-Service-Id-Token": string;
            };
            path: {
                /** @description NIHOの旧ExperienceProvider.id。Experience側のprovider IDは指定しない。 */
                legacyProviderId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description 旧providerのConnect account projection */
            200: {
                headers: {
                    "Cache-Control"?: "private, no-store";
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ExperienceHostLegacyConnectAccountResponse"];
                };
            };
            401: components["responses"]["ExperienceHostUnauthorized"];
            403: components["responses"]["ExperienceHostForbidden"];
            404: components["responses"]["ExperienceHostNotFound"];
            503: components["responses"]["ExperienceHostServiceUnavailable"];
        };
    };
    listExperienceProviderBookings: {
        parameters: {
            query?: {
                cursor?: string;
                fromDate?: string;
                pageId?: string;
                status?: components["schemas"]["ExperienceHostBookingKnownBookingStatus"];
                toDate?: string;
            };
            header?: never;
            path: {
                /** @description 提供者の ID（`ExperienceProvider.id`） */
                providerId: components["parameters"]["ExperienceProviderId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description provider-scoped bookings */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ExperienceHostBookingBookingListResponse"];
                };
            };
            401: components["responses"]["ExperienceHostUnauthorized"];
            403: components["responses"]["ExperienceHostForbidden"];
            404: components["responses"]["ExperienceHostNotFound"];
            409: components["responses"]["ExperienceHostConflict"];
            503: components["responses"]["ExperienceHostServiceUnavailable"];
        };
    };
    getExperienceProviderBooking: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description 提供者の ID（`ExperienceProvider.id`） */
                providerId: components["parameters"]["ExperienceProviderId"];
                requestId: components["parameters"]["ExperienceHostBookingRequestId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description canonical host booking DTO without Stripe identifiers */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ExperienceHostBookingBookingDetailResponse"];
                };
            };
            401: components["responses"]["ExperienceHostUnauthorized"];
            403: components["responses"]["ExperienceHostForbidden"];
            404: components["responses"]["ExperienceHostNotFound"];
            409: components["responses"]["ExperienceHostConflict"];
            503: components["responses"]["ExperienceHostServiceUnavailable"];
        };
    };
    approveExperienceProviderBooking: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description 企画ページの ID（SpotCampaignPage.id） */
                pageId: components["parameters"]["CampaignPageId"];
                /** @description 提供者の ID（`ExperienceProvider.id`） */
                providerId: components["parameters"]["ExperienceProviderId"];
                requestId: components["parameters"]["ExperienceHostBookingRequestId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description 予約の状態 */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ExperienceHostBookingBookingStatusResponse"];
                };
            };
            400: components["responses"]["ExperienceHostBadRequest"];
            401: components["responses"]["ExperienceHostUnauthorized"];
            403: components["responses"]["ExperienceHostForbidden"];
            404: components["responses"]["ExperienceHostNotFound"];
            409: components["responses"]["ExperienceHostConflict"];
            503: components["responses"]["ExperienceHostServiceUnavailable"];
        };
    };
    cancelExperienceProviderBooking: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description 企画ページの ID（SpotCampaignPage.id） */
                pageId: components["parameters"]["CampaignPageId"];
                /** @description 提供者の ID（`ExperienceProvider.id`） */
                providerId: components["parameters"]["ExperienceProviderId"];
                requestId: components["parameters"]["ExperienceHostBookingRequestId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ExperienceHostBookingCancelBookingInput"];
            };
        };
        responses: {
            /** @description existing booking cancellation service result */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ExperienceHostBookingCancelBookingResponse"];
                };
            };
            400: components["responses"]["ExperienceHostBadRequest"];
            401: components["responses"]["ExperienceHostUnauthorized"];
            403: components["responses"]["ExperienceHostForbidden"];
            404: components["responses"]["ExperienceHostNotFound"];
            409: components["responses"]["ExperienceHostConflict"];
            503: components["responses"]["ExperienceHostServiceUnavailable"];
        };
    };
    declineExperienceProviderBooking: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description 企画ページの ID（SpotCampaignPage.id） */
                pageId: components["parameters"]["CampaignPageId"];
                /** @description 提供者の ID（`ExperienceProvider.id`） */
                providerId: components["parameters"]["ExperienceProviderId"];
                requestId: components["parameters"]["ExperienceHostBookingRequestId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description 予約の状態 */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ExperienceHostBookingBookingStatusResponse"];
                };
            };
            400: components["responses"]["ExperienceHostBadRequest"];
            401: components["responses"]["ExperienceHostUnauthorized"];
            403: components["responses"]["ExperienceHostForbidden"];
            404: components["responses"]["ExperienceHostNotFound"];
            409: components["responses"]["ExperienceHostConflict"];
            503: components["responses"]["ExperienceHostServiceUnavailable"];
        };
    };
    messageExperienceProviderGuest: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description 企画ページの ID（SpotCampaignPage.id） */
                pageId: components["parameters"]["CampaignPageId"];
                /** @description 提供者の ID（`ExperienceProvider.id`） */
                providerId: components["parameters"]["ExperienceProviderId"];
                requestId: components["parameters"]["ExperienceHostBookingRequestId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ExperienceHostBookingMessageInput"];
            };
        };
        responses: {
            /** @description queued host message */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ExperienceHostBookingMessageResponse"];
                };
            };
            400: components["responses"]["ExperienceHostBadRequest"];
            401: components["responses"]["ExperienceHostUnauthorized"];
            403: components["responses"]["ExperienceHostForbidden"];
            404: components["responses"]["ExperienceHostNotFound"];
            409: components["responses"]["ExperienceHostConflict"];
            503: components["responses"]["ExperienceHostServiceUnavailable"];
        };
    };
}
