// このファイルは scripts/gen-types.ts が contract/experience-translate-rooms-api.openapi.json から生成する。手で編集しない。
// 更新: npm -C packages/api-client run gen:types
export type paths = {
    "/api/experience-providers/{providerId}/bookings/{requestId}/translate-rooms": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                providerId: components["parameters"]["ProviderId"];
                requestId: components["parameters"]["RequestId"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** @description 予約の languageSnapshot から言語を決め（EN → guest en・host ja）、host / guest の participant と 15 分有効の招待 code を作る。本文は空のオブジェクト。 */
        post: operations["createExperienceProviderTranslateRoom"];
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
                providerId: components["parameters"]["ProviderId"];
                requestId: components["parameters"]["RequestId"];
                roomId: components["parameters"]["RoomId"];
            };
            cookie?: never;
        };
        /** @description ホスト画面の 3 秒 polling。参加者ごとの joined / ready と使用分。 */
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
                providerId: components["parameters"]["ProviderId"];
                requestId: components["parameters"]["RequestId"];
                roomId: components["parameters"]["RoomId"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** @description ホストが部屋を終える。招待 code は使えなくなる。 */
        post: operations["endExperienceProviderTranslateRoom"];
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
        CreateTranslateRoomInput: Record<string, never>;
        EndTranslateRoomInput: Record<string, never>;
        TranslateInvite: {
            inviteCode: string;
            /** Format: uri */
            inviteUrl: string;
            participantId: string;
        };
        /** @enum {string} */
        TranslateParticipantRole: "host" | "guest";
        TranslateRoomCreatedResponse: {
            /** Format: date-time */
            expiresAt: string;
            guest: components["schemas"]["TranslateInvite"];
            host: components["schemas"]["TranslateInvite"];
            roomId: string;
            state: components["schemas"]["TranslateRoomState"];
        };
        TranslateRoomEndResponse: {
            state: components["schemas"]["TranslateRoomState"];
        };
        TranslateRoomParticipant: {
            joined: boolean;
            ready: boolean;
            role: components["schemas"]["TranslateParticipantRole"];
        };
        /** @enum {string} */
        TranslateRoomState: "created" | "active" | "paused" | "ended";
        TranslateRoomStatusResponse: {
            participants: components["schemas"]["TranslateRoomParticipant"][];
            state: components["schemas"]["TranslateRoomState"];
            usageMinutes: number;
        };
    };
    responses: never;
    parameters: {
        ProviderId: string;
        RequestId: string;
        RoomId: string;
    };
    requestBodies: never;
    headers: never;
    pathItems: never;
};
export type $defs = Record<string, never>;
export interface operations {
    createExperienceProviderTranslateRoom: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                providerId: components["parameters"]["ProviderId"];
                requestId: components["parameters"]["RequestId"];
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["CreateTranslateRoomInput"];
            };
        };
        responses: {
            /** @description the room and both invite URLs */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["TranslateRoomCreatedResponse"];
                };
            };
        };
    };
    getExperienceProviderTranslateRoom: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                providerId: components["parameters"]["ProviderId"];
                requestId: components["parameters"]["RequestId"];
                roomId: components["parameters"]["RoomId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description room state, participants and usage */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["TranslateRoomStatusResponse"];
                };
            };
        };
    };
    endExperienceProviderTranslateRoom: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                providerId: components["parameters"]["ProviderId"];
                requestId: components["parameters"]["RequestId"];
                roomId: components["parameters"]["RoomId"];
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["EndTranslateRoomInput"];
            };
        };
        responses: {
            /** @description the final state */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["TranslateRoomEndResponse"];
                };
            };
        };
    };
}
