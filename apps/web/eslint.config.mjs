import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const SERVER_ONLY_HOST_API = "ホスト API のクライアントはサーバー専用です（ID token を送る）。src/lib/host/server.ts の hostApiClient を使い、ブラウザからは /host/api/* を呼んでください。型だけの import はどこからでもよい。";
const SERVER_ONLY_ADMIN_AUTH = "Admin認証SDKはサーバー専用です（tokenを扱う）。src/lib/admin/server.tsを経由し、ブラウザへtokenを渡さないでください。型だけのimportは許可されます。";
const SERVER_ONLY_ADMIN_READ = "Admin read SDKはサーバー専用です（tokenを扱う）。src/lib/admin/server.tsを経由し、ブラウザからは/admin/api/*を呼んでください。型だけのimportは許可されます。";
const hostSdkFiles = ["src/lib/host/server.ts", "src/lib/host/mock-niho.ts", "src/host/connect.ts"];
const adminSdkFiles = ["src/lib/admin/server.ts", "src/lib/admin/http-session.ts", "src/app/(admin)/admin/auth/login/route.ts"];
const hostSdkImports = [
  { name: "@niho-experience/api-client/host", message: SERVER_ONLY_HOST_API, allowTypeImports: true },
  { name: "@niho-experience/api-client/host/mock", message: SERVER_ONLY_HOST_API, allowTypeImports: true },
];
const adminSdkImports = [
  { name: "@niho-experience/api-client/admin-auth", message: SERVER_ONLY_ADMIN_AUTH, allowTypeImports: true },
  { name: "@niho-experience/api-client/admin-read", message: SERVER_ONLY_ADMIN_READ, allowTypeImports: true },
];

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    // The host API client sends the host's ID token: only the server-only module may load it at runtime.
    // src/host/connect.ts (server-only) loads it for isStripeConnectUrl, to check a Stripe link before it is followed.
    files: ["**/*.ts", "**/*.tsx"],
    ignores: [...hostSdkFiles, ...adminSdkFiles],
    rules: {
      "@typescript-eslint/no-restricted-imports": ["error", {
        paths: [...hostSdkImports, ...adminSdkImports],
      }],
    },
  },
  // Each server boundary can load its own SDK; adding Admin must not widen the host SDK allowlist.
  {
    files: adminSdkFiles,
    rules: { "@typescript-eslint/no-restricted-imports": ["error", { paths: hostSdkImports }] },
  },
  {
    files: hostSdkFiles,
    rules: { "@typescript-eslint/no-restricted-imports": ["error", { paths: adminSdkImports }] },
  },
  globalIgnores([".next/**", "next-env.d.ts", "playwright-report/**", "test-results/**"]),
]);
