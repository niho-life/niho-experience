// このファイルは scripts/gen-types.ts が contract/experience-translate-rooms-api.openapi.json から生成する。手で編集しない。
// 更新: npm -C packages/api-client run gen:types
export type paths = {
    "/api/experience-providers/{providerId}/bookings/{requestId}/translate-rooms": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description 体験の提供者（ExperienceProvider）のID。 */
                providerId: components["parameters"]["TranslateExperienceProviderId"];
                /** @description 体験の予約（SpotCampaignPageBookingRequest）のID。 */
                requestId: components["parameters"]["TranslateBookingRequestId"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * 体験の予約から通訳ルームを作り、host / guestの招待codeとURLを返す
         * @description 体験サイトのホスト画面（experience.niho.life/host）から、確定済みの予約に対して1部屋を作る。名義は体験の提供者。
         *     言語は予約の`languageSnapshot`（EN → guest en / host ja、JA → guest ja / host en）。招待codeはこの応答にだけ平文で載り、
         *     DBにはhashだけ残る。同じ予約に有効な部屋があるときは409（`TRANSLATE_ROOM_EXISTS`・detailsに`roomId`）で、終了してから作り直す。
         *     通訳が未設定の環境では503。
         */
        post: operations["postExperienceProviderTranslateRoom"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/experience-providers/{providerId}/bookings/{requestId}/translate-rooms/{roomId}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description 体験の提供者（ExperienceProvider）のID。 */
                providerId: components["parameters"]["TranslateExperienceProviderId"];
                /** @description 体験の予約（SpotCampaignPageBookingRequest）のID。 */
                requestId: components["parameters"]["TranslateBookingRequestId"];
                /** @description 対面通訳ルームの仮ID。NIHO user IDではない。 */
                roomId: components["parameters"]["TranslateRoomId"];
            };
            cookie?: never;
        };
        /** 通訳ルームの状態・参加状況・使用分（ホスト画面の3秒polling） */
        get: operations["getExperienceProviderTranslateRoom"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/experience-providers/{providerId}/bookings/{requestId}/translate-rooms/{roomId}/end": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description 体験の提供者（ExperienceProvider）のID。 */
                providerId: components["parameters"]["TranslateExperienceProviderId"];
                /** @description 体験の予約（SpotCampaignPageBookingRequest）のID。 */
                requestId: components["parameters"]["TranslateBookingRequestId"];
                /** @description 対面通訳ルームの仮ID。NIHO user IDではない。 */
                roomId: components["parameters"]["TranslateRoomId"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** 通訳ルームを終了する（招待codeと接続資格を失効） */
        post: operations["postExperienceProviderTranslateRoomEnd"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/experience-providers/{providerId}/site-bookings/{bookingId}/translate-rooms": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Experience DBが発行する外部公開予約UUID。NIHOの予約IDや旅行者PIIではない。 */
                bookingId: components["parameters"]["TranslateExperienceBookingId"];
                /** @description 体験の提供者（ExperienceProvider）のID。 */
                providerId: components["parameters"]["TranslateExperienceProviderId"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Experience DBの予約文脈から日英通訳ルームを作る
         * @description NIHOはprovider・通訳・予算の正本として、providerに属するopaqueな外部予約文脈を受け取る。
         *     外部予約の実在・確定・取消・日付はExperience BFFが検証し、このAPIは検証済みと主張しない。
         *     v1の言語はhost ja / guest en固定。role・language・budgetはrequest bodyで受け取らない。
         *     同じproviderとbookingIdに未終了かつ未期限切れの部屋がある場合は409。
         */
        post: operations["postExperienceBookingTranslateRoom"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/experience-providers/{providerId}/site-bookings/{bookingId}/translate-rooms/{roomId}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Experience DBが発行する外部公開予約UUID。NIHOの予約IDや旅行者PIIではない。 */
                bookingId: components["parameters"]["TranslateExperienceBookingId"];
                /** @description 体験の提供者（ExperienceProvider）のID。 */
                providerId: components["parameters"]["TranslateExperienceProviderId"];
                /** @description 対面通訳ルームの仮ID。NIHO user IDではない。 */
                roomId: components["parameters"]["TranslateRoomId"];
            };
            cookie?: never;
        };
        /** Experience DBの予約に紐づく通訳ルーム状態を返す */
        get: operations["getExperienceBookingTranslateRoom"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/experience-providers/{providerId}/site-bookings/{bookingId}/translate-rooms/{roomId}/end": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Experience DBが発行する外部公開予約UUID。NIHOの予約IDや旅行者PIIではない。 */
                bookingId: components["parameters"]["TranslateExperienceBookingId"];
                /** @description 体験の提供者（ExperienceProvider）のID。 */
                providerId: components["parameters"]["TranslateExperienceProviderId"];
                /** @description 対面通訳ルームの仮ID。NIHO user IDではない。 */
                roomId: components["parameters"]["TranslateRoomId"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Experience DBの予約に紐づく通訳ルームを終了する */
        post: operations["postExperienceBookingTranslateRoomEnd"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/experience-providers/{providerId}/translate-rooms": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description 体験の提供者（ExperienceProvider）のID。 */
                providerId: components["parameters"]["TranslateExperienceProviderId"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * 予約なしの通訳ルームを作る
         * @description 現在のprovider OWNER向け予約なし通訳。予約付きroomを含めず、秘密・音声・字幕を保存しない。
         */
        post: operations["postStandaloneTranslateRoom"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/experience-providers/{providerId}/translate-rooms/{roomId}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description 体験の提供者（ExperienceProvider）のID。 */
                providerId: components["parameters"]["TranslateExperienceProviderId"];
                /** @description 対面通訳ルームの仮ID。NIHO user IDではない。 */
                roomId: components["parameters"]["TranslateRoomId"];
            };
            cookie?: never;
        };
        /**
         * 予約なしルームの参加状況を取得する
         * @description 現在のprovider OWNER向け予約なし通訳。予約付きroomを含めず、秘密・音声・字幕を保存しない。
         */
        get: operations["getStandaloneTranslateRoom"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/experience-providers/{providerId}/translate-rooms/{roomId}/end": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description 体験の提供者（ExperienceProvider）のID。 */
                providerId: components["parameters"]["TranslateExperienceProviderId"];
                /** @description 対面通訳ルームの仮ID。NIHO user IDではない。 */
                roomId: components["parameters"]["TranslateRoomId"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * 予約なしルームを終了する
         * @description 現在のprovider OWNER向け予約なし通訳。予約付きroomを含めず、秘密・音声・字幕を保存しない。
         */
        post: operations["postStandaloneTranslateRoomEnd"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/experience-providers/{providerId}/translate-rooms/{roomId}/invites/guest": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description 体験の提供者（ExperienceProvider）のID。 */
                providerId: components["parameters"]["TranslateExperienceProviderId"];
                /** @description 対面通訳ルームの仮ID。NIHO user IDではない。 */
                roomId: components["parameters"]["TranslateRoomId"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * 対象席の招待を明示再発行して旧資格を失効する
         * @description 現在のprovider OWNER向け予約なし通訳。予約付きroomを含めず、秘密・音声・字幕を保存しない。
         */
        post: operations["postStandaloneTranslateGuestInvite"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/experience-providers/{providerId}/translate-rooms/{roomId}/invites/host": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description 体験の提供者（ExperienceProvider）のID。 */
                providerId: components["parameters"]["TranslateExperienceProviderId"];
                /** @description 対面通訳ルームの仮ID。NIHO user IDではない。 */
                roomId: components["parameters"]["TranslateRoomId"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * 対象席の招待を明示再発行して旧資格を失効する
         * @description 現在のprovider OWNER向け予約なし通訳。予約付きroomを含めず、秘密・音声・字幕を保存しない。
         */
        post: operations["postStandaloneTranslateHostInvite"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/experience-providers/{providerId}/translate-rooms/current": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description 体験の提供者（ExperienceProvider）のID。 */
                providerId: components["parameters"]["TranslateExperienceProviderId"];
            };
            cookie?: never;
        };
        /**
         * 進行中の予約なしルームを復元する（なければroomはnull）
         * @description 現在のprovider OWNER向け予約なし通訳。予約付きroomを含めず、秘密・音声・字幕を保存しない。
         */
        get: operations["getCurrentStandaloneTranslateRoom"];
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
        EmptyObject: Record<string, never>;
        ExperienceProviderTranslateRoomCreated: {
            /**
             * Format: date-time
             * @description 部屋の寿命（作成から90分）
             */
            expiresAt: string;
            guest: components["schemas"]["TranslateInviteParticipant"];
            host: components["schemas"]["TranslateInviteParticipant"];
            roomId: string;
            /** @enum {string} */
            state: "waiting" | "active" | "paused" | "ended";
        };
        ExperienceProviderTranslateRoomParticipant: {
            /** @description relayに接続中（直近15秒以内のpresence） */
            joined: boolean;
            /** @description SDKのready（同意・イヤフォン・権限が揃った）を直近15秒以内に申告した */
            ready: boolean;
            /** @enum {string} */
            role: "host" | "guest";
        };
        ExperienceProviderTranslateRoomStatus: {
            participants: components["schemas"]["ExperienceProviderTranslateRoomParticipant"][];
            /** @enum {string} */
            state: "waiting" | "active" | "paused" | "ended";
            /** @description 入力音声の合計分（0.1分単位・切り上げ）。予算の前払い予約とは別 */
            usageMinutes: number;
        };
        StandaloneTranslateInvite: {
            /** Format: date-time */
            expiresAt: string;
            /** Format: uri */
            inviteUrl: string;
        };
        StandaloneTranslateInviteResult: {
            invite: components["schemas"]["StandaloneTranslateInvite"];
            /** @enum {string} */
            role: "host" | "guest";
            roomId: string;
        };
        StandaloneTranslateRoom: {
            /** Format: date-time */
            expiresAt: string;
            guestLanguage: components["schemas"]["TranslateLanguage"];
            hostLanguage: components["schemas"]["TranslateLanguage"];
            participants: components["schemas"]["ExperienceProviderTranslateRoomParticipant"][];
            roomId: string;
            /** @enum {string} */
            state: "waiting" | "active" | "paused" | "ended";
            usageMinutes: number;
        };
        StandaloneTranslateRoomCreated: {
            guest: components["schemas"]["StandaloneTranslateInvite"];
            host: components["schemas"]["StandaloneTranslateInvite"];
            room: components["schemas"]["StandaloneTranslateRoom"];
        };
        StandaloneTranslateRoomCreateRequest: {
            hostLanguage: components["schemas"]["TranslateLanguage"];
        };
        StandaloneTranslateRoomCurrent: {
            room: components["schemas"]["StandaloneTranslateRoom"] | null;
        };
        TranslateInviteParticipant: {
            /** @description 作成応答にだけ平文で載る。DBはhashだけ */
            inviteCode: string;
            /**
             * Format: uri
             * @description `{TRANSLATE_INVITE_BASE_URL}/t#<code>`（本番 https://niho.life、stg https://app-stg.niho.life。codeはfragmentに置き、`/i/` は会員招待の短縮リンクなので使わない）
             */
            inviteUrl: string;
            participantId: string;
        };
        /** @enum {string} */
        TranslateLanguage: "ja" | "en";
        TranslateRoomStateResult: {
            roomId: string;
            /** @enum {string} */
            state: "waiting" | "active" | "paused" | "ended";
        };
    };
    responses: never;
    parameters: {
        /** @description 体験の予約（SpotCampaignPageBookingRequest）のID。 */
        TranslateBookingRequestId: string;
        /** @description Experience DBが発行する外部公開予約UUID。NIHOの予約IDや旅行者PIIではない。 */
        TranslateExperienceBookingId: string;
        /** @description 体験の提供者（ExperienceProvider）のID。 */
        TranslateExperienceProviderId: string;
        /** @description 対面通訳ルームの仮ID。NIHO user IDではない。 */
        TranslateRoomId: string;
    };
    requestBodies: never;
    headers: never;
    pathItems: never;
};
export type $defs = Record<string, never>;
export interface operations {
    postExperienceProviderTranslateRoom: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description 体験の提供者（ExperienceProvider）のID。 */
                providerId: components["parameters"]["TranslateExperienceProviderId"];
                /** @description 体験の予約（SpotCampaignPageBookingRequest）のID。 */
                requestId: components["parameters"]["TranslateBookingRequestId"];
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["EmptyObject"];
            };
        };
        responses: {
            /** @description 作成済み */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ExperienceProviderTranslateRoomCreated"];
                };
            };
            /** @description NIHO API error (400) */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description NIHO API error (401) */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description NIHO API error (404) */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description NIHO API error (409) */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description NIHO API error (413) */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description NIHO API error (429) */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description NIHO API error (503) */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    getExperienceProviderTranslateRoom: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description 体験の提供者（ExperienceProvider）のID。 */
                providerId: components["parameters"]["TranslateExperienceProviderId"];
                /** @description 体験の予約（SpotCampaignPageBookingRequest）のID。 */
                requestId: components["parameters"]["TranslateBookingRequestId"];
                /** @description 対面通訳ルームの仮ID。NIHO user IDではない。 */
                roomId: components["parameters"]["TranslateRoomId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description 成功 */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ExperienceProviderTranslateRoomStatus"];
                };
            };
            /** @description NIHO API error (401) */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description NIHO API error (404) */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description NIHO API error (429) */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description NIHO API error (503) */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    postExperienceProviderTranslateRoomEnd: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description 体験の提供者（ExperienceProvider）のID。 */
                providerId: components["parameters"]["TranslateExperienceProviderId"];
                /** @description 体験の予約（SpotCampaignPageBookingRequest）のID。 */
                requestId: components["parameters"]["TranslateBookingRequestId"];
                /** @description 対面通訳ルームの仮ID。NIHO user IDではない。 */
                roomId: components["parameters"]["TranslateRoomId"];
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["EmptyObject"];
            };
        };
        responses: {
            /** @description 終了済み */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["TranslateRoomStateResult"];
                };
            };
            /** @description NIHO API error (400) */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description NIHO API error (401) */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description NIHO API error (404) */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description NIHO API error (413) */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description NIHO API error (429) */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description NIHO API error (503) */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    postExperienceBookingTranslateRoom: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Experience DBが発行する外部公開予約UUID。NIHOの予約IDや旅行者PIIではない。 */
                bookingId: components["parameters"]["TranslateExperienceBookingId"];
                /** @description 体験の提供者（ExperienceProvider）のID。 */
                providerId: components["parameters"]["TranslateExperienceProviderId"];
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["EmptyObject"];
            };
        };
        responses: {
            /** @description 作成済み */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ExperienceProviderTranslateRoomCreated"];
                };
            };
            /** @description NIHO API error (400) */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description NIHO API error (401) */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description NIHO API error (404) */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description NIHO API error (409) */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description NIHO API error (413) */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description NIHO API error (429) */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description NIHO API error (503) */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    getExperienceBookingTranslateRoom: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Experience DBが発行する外部公開予約UUID。NIHOの予約IDや旅行者PIIではない。 */
                bookingId: components["parameters"]["TranslateExperienceBookingId"];
                /** @description 体験の提供者（ExperienceProvider）のID。 */
                providerId: components["parameters"]["TranslateExperienceProviderId"];
                /** @description 対面通訳ルームの仮ID。NIHO user IDではない。 */
                roomId: components["parameters"]["TranslateRoomId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description 成功 */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ExperienceProviderTranslateRoomStatus"];
                };
            };
            /** @description NIHO API error (401) */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description NIHO API error (404) */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description NIHO API error (429) */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description NIHO API error (503) */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    postExperienceBookingTranslateRoomEnd: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Experience DBが発行する外部公開予約UUID。NIHOの予約IDや旅行者PIIではない。 */
                bookingId: components["parameters"]["TranslateExperienceBookingId"];
                /** @description 体験の提供者（ExperienceProvider）のID。 */
                providerId: components["parameters"]["TranslateExperienceProviderId"];
                /** @description 対面通訳ルームの仮ID。NIHO user IDではない。 */
                roomId: components["parameters"]["TranslateRoomId"];
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["EmptyObject"];
            };
        };
        responses: {
            /** @description 終了済み */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["TranslateRoomStateResult"];
                };
            };
            /** @description NIHO API error (400) */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description NIHO API error (401) */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description NIHO API error (404) */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description NIHO API error (413) */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description NIHO API error (429) */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description NIHO API error (503) */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    postStandaloneTranslateRoom: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description 体験の提供者（ExperienceProvider）のID。 */
                providerId: components["parameters"]["TranslateExperienceProviderId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["StandaloneTranslateRoomCreateRequest"];
            };
        };
        responses: {
            /** @description 成功 */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["StandaloneTranslateRoomCreated"];
                };
            };
            /** @description NIHO API error (400) */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description NIHO API error (401) */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description NIHO API error (403) */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description NIHO API error (404) */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description NIHO API error (409) */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description NIHO API error (413) */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description NIHO API error (429) */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description NIHO API error (503) */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    getStandaloneTranslateRoom: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description 体験の提供者（ExperienceProvider）のID。 */
                providerId: components["parameters"]["TranslateExperienceProviderId"];
                /** @description 対面通訳ルームの仮ID。NIHO user IDではない。 */
                roomId: components["parameters"]["TranslateRoomId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description 成功 */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["StandaloneTranslateRoom"];
                };
            };
            /** @description NIHO API error (400) */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description NIHO API error (401) */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description NIHO API error (403) */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description NIHO API error (404) */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description NIHO API error (409) */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description NIHO API error (413) */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description NIHO API error (429) */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description NIHO API error (503) */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    postStandaloneTranslateRoomEnd: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description 体験の提供者（ExperienceProvider）のID。 */
                providerId: components["parameters"]["TranslateExperienceProviderId"];
                /** @description 対面通訳ルームの仮ID。NIHO user IDではない。 */
                roomId: components["parameters"]["TranslateRoomId"];
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["EmptyObject"];
            };
        };
        responses: {
            /** @description 成功 */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["TranslateRoomStateResult"];
                };
            };
            /** @description NIHO API error (400) */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description NIHO API error (401) */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description NIHO API error (403) */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description NIHO API error (404) */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description NIHO API error (409) */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description NIHO API error (413) */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description NIHO API error (429) */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description NIHO API error (503) */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    postStandaloneTranslateGuestInvite: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description 体験の提供者（ExperienceProvider）のID。 */
                providerId: components["parameters"]["TranslateExperienceProviderId"];
                /** @description 対面通訳ルームの仮ID。NIHO user IDではない。 */
                roomId: components["parameters"]["TranslateRoomId"];
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["EmptyObject"];
            };
        };
        responses: {
            /** @description 成功 */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["StandaloneTranslateInviteResult"];
                };
            };
            /** @description NIHO API error (400) */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description NIHO API error (401) */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description NIHO API error (403) */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description NIHO API error (404) */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description NIHO API error (409) */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description NIHO API error (413) */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description NIHO API error (429) */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description NIHO API error (503) */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    postStandaloneTranslateHostInvite: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description 体験の提供者（ExperienceProvider）のID。 */
                providerId: components["parameters"]["TranslateExperienceProviderId"];
                /** @description 対面通訳ルームの仮ID。NIHO user IDではない。 */
                roomId: components["parameters"]["TranslateRoomId"];
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["EmptyObject"];
            };
        };
        responses: {
            /** @description 成功 */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["StandaloneTranslateInviteResult"];
                };
            };
            /** @description NIHO API error (400) */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description NIHO API error (401) */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description NIHO API error (403) */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description NIHO API error (404) */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description NIHO API error (409) */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description NIHO API error (413) */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description NIHO API error (429) */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description NIHO API error (503) */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    getCurrentStandaloneTranslateRoom: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description 体験の提供者（ExperienceProvider）のID。 */
                providerId: components["parameters"]["TranslateExperienceProviderId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description 成功 */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["StandaloneTranslateRoomCurrent"];
                };
            };
            /** @description NIHO API error (400) */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description NIHO API error (401) */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description NIHO API error (403) */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description NIHO API error (404) */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description NIHO API error (409) */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description NIHO API error (413) */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description NIHO API error (429) */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description NIHO API error (503) */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
}
