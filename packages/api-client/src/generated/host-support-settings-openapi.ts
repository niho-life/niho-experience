// このファイルは scripts/gen-types.ts が contract/experience-host-support-settings-api.openapi.json から生成する。手で編集しない。
// 更新: npm -C packages/api-client run gen:types
export type paths = {
    "/api/experience-providers/management/niho-support-hosts": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * ホスト本人がNIHOサポート設定を変更できる対象を列挙する
         * @description 現在有効な本人OWNERの通常Spotと外部Providerだけを、kind/idの安定順で最大100件返す。
         *     ProviderはDRAFTを含む既知状態かつactiveな専用vessel、SpotはProvider vesselでない通常拠点に限定する。
         *     platform ADMIN・STAFF・EDITOR・共通決済口座はOWNER権限へ読み替えない。queryは受け付けない。
         */
        get: operations["listManagedExperienceNihoSupportHosts"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/experience-providers/management/niho-support/{hostKind}/{hostId}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                hostId: string;
                hostKind: "SPOT" | "EXPERIENCE_PROVIDER";
            };
            cookie?: never;
        };
        /**
         * ホスト本人が現在のNIHOサポート設定を読む
         * @description 現在有効なOWNER本人だけが読む。設定なしはUNSET、現在版の有効snapshotはCURRENT、旧版・不正版は
         *     RECONSENT_REQUIREDとして保存値を返し、現在のOFFへ補完しない。queryは受け付けない。
         */
        get: operations["getManagedExperienceNihoSupportSetting"];
        /**
         * ホスト本人がNIHOサポートへ再同意して設定を保存する
         * @description 現在有効なOWNER本人を設定保存transaction内で再検証し、expectedRevisionでCASする。
         *     同じ本人・同payloadの応答消失再送だけ同じ結果へ収束する。設定は新規受付だけに使う準備段階で、
         *     このAPIの保存だけでは料金・予約snapshotへ接続済みにならない。書込みflagがOFFなら503。
         */
        put: operations["putManagedExperienceNihoSupportSetting"];
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
        ExperienceHostSupportSettingsError: {
            error: {
                code: string;
                details: {
                    [key: string]: unknown;
                };
                message: string;
            };
        };
        ExperienceHostSupportSettingsHost: {
            displayName: string;
            id: string;
            /** @enum {string} */
            kind: "SPOT" | "EXPERIENCE_PROVIDER";
        };
        ExperienceHostSupportSettingsHostListResponse: {
            hosts: components["schemas"]["ExperienceHostSupportSettingsHost"][];
            /** @enum {integer} */
            limit: 100;
            truncated: boolean;
        };
        ExperienceHostSupportSettingsPolicy: {
            /** @enum {string} */
            consentVersion: "2026-10-23";
            /** @enum {integer} */
            offTotalRateBps: 1000;
            /** @enum {integer} */
            onTotalRateBps: 1500;
            /** @enum {boolean} */
            peopleCostPaidDirectlyByHost: true;
            /** @enum {string} */
            policyVersion: "2026-10-23";
            /** @enum {boolean} */
            processingFeesIncluded: true;
        };
        ExperienceHostSupportSettingsPutRequest: {
            /** @enum {string} */
            consentVersion: "2026-10-23";
            enabled: boolean;
            expectedRevision: number;
        };
        ExperienceHostSupportSettingsSetting: {
            agreementRevision: number;
            /** Format: date-time */
            consentedAt: string;
            consentVersion: string;
            enabled: boolean;
            policyVersion: string;
            revision: number;
            sharedConsultationMemo: string | null;
            /** Format: date-time */
            updatedAt: string;
        };
        ExperienceHostSupportSettingsStateResponse: {
            host: components["schemas"]["ExperienceHostSupportSettingsHost"];
            policy: components["schemas"]["ExperienceHostSupportSettingsPolicy"];
            setting: components["schemas"]["ExperienceHostSupportSettingsSetting"] | null;
            /** @enum {string} */
            settingState: "UNSET" | "CURRENT" | "RECONSENT_REQUIRED";
            writeCapability: components["schemas"]["ExperienceHostSupportSettingsWriteCapability"];
        };
        ExperienceHostSupportSettingsWriteCapability: {
            /** @enum {object|null} */
            reason: never | null;
            /** @enum {boolean} */
            writable: true;
        } | {
            /** @enum {string} */
            reason: "SUPPORT_WRITES_DISABLED";
            /** @enum {boolean} */
            writable: false;
        };
    };
    responses: never;
    parameters: never;
    requestBodies: never;
    headers: {
        /** @description ホスト本人の支援設定・共有相談内容を共有cacheへ保存しない。 */
        ExperienceHostSupportSettingsPrivateNoStore: "private, no-store";
    };
    pathItems: never;
};
export type $defs = Record<string, never>;
export interface operations {
    listManagedExperienceNihoSupportHosts: {
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
                    "Cache-Control": components["headers"]["ExperienceHostSupportSettingsPrivateNoStore"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ExperienceHostSupportSettingsHostListResponse"];
                };
            };
            /** @description Query is not allowed */
            400: {
                headers: {
                    "Cache-Control": components["headers"]["ExperienceHostSupportSettingsPrivateNoStore"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ExperienceHostSupportSettingsError"];
                };
            };
            /** @description Authentication required */
            401: {
                headers: {
                    "Cache-Control": components["headers"]["ExperienceHostSupportSettingsPrivateNoStore"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ExperienceHostSupportSettingsError"];
                };
            };
            /** @description Current user is unavailable */
            403: {
                headers: {
                    "Cache-Control": components["headers"]["ExperienceHostSupportSettingsPrivateNoStore"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ExperienceHostSupportSettingsError"];
                };
            };
            /** @description Method not allowed */
            405: {
                headers: {
                    Allow?: "GET";
                    "Cache-Control": components["headers"]["ExperienceHostSupportSettingsPrivateNoStore"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ExperienceHostSupportSettingsError"];
                };
            };
        };
    };
    getManagedExperienceNihoSupportSetting: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                hostId: string;
                hostKind: "SPOT" | "EXPERIENCE_PROVIDER";
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description OK */
            200: {
                headers: {
                    "Cache-Control": components["headers"]["ExperienceHostSupportSettingsPrivateNoStore"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ExperienceHostSupportSettingsStateResponse"];
                };
            };
            /** @description Invalid kind or query */
            400: {
                headers: {
                    "Cache-Control": components["headers"]["ExperienceHostSupportSettingsPrivateNoStore"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ExperienceHostSupportSettingsError"];
                };
            };
            /** @description Authentication required */
            401: {
                headers: {
                    "Cache-Control": components["headers"]["ExperienceHostSupportSettingsPrivateNoStore"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ExperienceHostSupportSettingsError"];
                };
            };
            /** @description Current OWNER permission required */
            403: {
                headers: {
                    "Cache-Control": components["headers"]["ExperienceHostSupportSettingsPrivateNoStore"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ExperienceHostSupportSettingsError"];
                };
            };
            /** @description Host not found or malformed opaque ID */
            404: {
                headers: {
                    "Cache-Control": components["headers"]["ExperienceHostSupportSettingsPrivateNoStore"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ExperienceHostSupportSettingsError"];
                };
            };
            /** @description Method not allowed */
            405: {
                headers: {
                    Allow?: "GET, PUT";
                    "Cache-Control": components["headers"]["ExperienceHostSupportSettingsPrivateNoStore"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ExperienceHostSupportSettingsError"];
                };
            };
        };
    };
    putManagedExperienceNihoSupportSetting: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                hostId: string;
                hostKind: "SPOT" | "EXPERIENCE_PROVIDER";
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ExperienceHostSupportSettingsPutRequest"];
            };
        };
        responses: {
            /** @description OK */
            200: {
                headers: {
                    "Cache-Control": components["headers"]["ExperienceHostSupportSettingsPrivateNoStore"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ExperienceHostSupportSettingsStateResponse"];
                };
            };
            /** @description Invalid JSON body, kind, or query */
            400: {
                headers: {
                    "Cache-Control": components["headers"]["ExperienceHostSupportSettingsPrivateNoStore"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ExperienceHostSupportSettingsError"];
                };
            };
            /** @description Authentication required */
            401: {
                headers: {
                    "Cache-Control": components["headers"]["ExperienceHostSupportSettingsPrivateNoStore"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ExperienceHostSupportSettingsError"];
                };
            };
            /** @description Current OWNER permission required */
            403: {
                headers: {
                    "Cache-Control": components["headers"]["ExperienceHostSupportSettingsPrivateNoStore"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ExperienceHostSupportSettingsError"];
                };
            };
            /** @description Host not found or malformed opaque ID */
            404: {
                headers: {
                    "Cache-Control": components["headers"]["ExperienceHostSupportSettingsPrivateNoStore"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ExperienceHostSupportSettingsError"];
                };
            };
            /** @description Revision conflict */
            409: {
                headers: {
                    "Cache-Control": components["headers"]["ExperienceHostSupportSettingsPrivateNoStore"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ExperienceHostSupportSettingsError"];
                };
            };
            /** @description Request body exceeds the stream limit */
            413: {
                headers: {
                    "Cache-Control": components["headers"]["ExperienceHostSupportSettingsPrivateNoStore"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ExperienceHostSupportSettingsError"];
                };
            };
            /** @description Content-Type must be application/json */
            415: {
                headers: {
                    "Cache-Control": components["headers"]["ExperienceHostSupportSettingsPrivateNoStore"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ExperienceHostSupportSettingsError"];
                };
            };
            /** @description Support writes are disabled */
            503: {
                headers: {
                    "Cache-Control": components["headers"]["ExperienceHostSupportSettingsPrivateNoStore"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ExperienceHostSupportSettingsError"];
                };
            };
        };
    };
}
