export declare const RENDERER_VERSION_V1: "niho-experience-presentation/v1";
export declare const STYLE_ID_V1: "niho-experience-presentation/v1/scoped-css";
export declare const PRESENTATION_MANIFEST_V1: Readonly<{
    readonly renderer: "niho-experience-presentation/v1";
    readonly copy: {
        readonly schemaVersion: 1;
        readonly sha256: "1d73b4c80ae1025321532ff3be81430a5e43abfa6ca72d6aef8f57dc2da2a307";
    };
    readonly staticCopy: {
        readonly schemaVersion: 2;
        readonly keyCount: number;
        readonly sha256: "242e2111e705a14755d10f13d8d16820792ea1aeac3f337b9b01babbfdb106a9";
    };
    readonly assets: {
        readonly schemaVersion: 1;
        readonly sha256: "2ba41a362cbd003319506f1b53ae6b910205304adbd000aab49fca4dce55d7fa";
    };
    readonly style: {
        readonly id: "niho-experience-presentation/v1/scoped-css";
        readonly sha256: "4c79c7ec15b212415c0fdf790b9b373202ab45062842b5ca991306bdf127e2cd";
        readonly fonts: {
            readonly "nunito-latin-wght-normal.woff2": "ba344451eab25b217a165363b1982048a5e5830a0daf36577973955a04cac793";
            readonly "nunito-latin-ext-wght-normal.woff2": "2c8d792869818ecb253a46bc3c63c7013df7aac2f69291c3c85e5cdc94160960";
            readonly "fraunces-latin-wght-normal.woff2": "7f9d191d999336d3b9790afa72e1358e50a13b06d4f289341e92a311967a80f9";
            readonly "fraunces-latin-ext-wght-normal.woff2": "a21ecfbf41fbc393e24ef9b7e38532a27e8da5e0a074aa7d66802d1b5ccec2f0";
            readonly "caveat-latin-wght-normal.woff2": "891951df5e8b5b0f0bc760d31375405e795c666b5add70437de12d4a6482b33f";
            readonly "caveat-latin-ext-wght-normal.woff2": "f626b95c1efa95cf6b7c9b043d3bbe8862b6abbe5f55a082102f33f7de2fd4f9";
        };
    };
    readonly reactPeer: "^18.2.0 || ^19.0.0";
}>;
export type PresentationIdentityV1 = typeof PRESENTATION_MANIFEST_V1;
export declare function assertPresentationIdentityV1(value: unknown): asserts value is PresentationIdentityV1;
