// 契約から型を作る。公開 API（contract/experience-public-api.openapi.json → src/generated/openapi.ts）と
// ホスト API（contract/experience-host-api.openapi.json → src/generated/host-openapi.ts）、
// Admin read API（contract/experience-admin-read-api.openapi.json → src/generated/admin-read-openapi.ts）、
// Admin support case / operations API、host support history / settings API、fee summary API を含む選別契約。
// `--check` は書き込まず、生成結果とコミット済みの型が 1 つでも違えば失敗する（CI の drift 検査）。
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import openapiTS, { astToString } from "openapi-typescript";

export type ContractTarget = "public" | "host" | "admin-read" | "admin-support-case" | "admin-operations" | "host-support-history" | "host-support-settings" | "fee-summary";

const TARGETS: Record<ContractTarget, { contract: string; output: string }> = {
  public: { contract: "experience-public-api.openapi.json", output: "openapi.ts" },
  host: { contract: "experience-host-api.openapi.json", output: "host-openapi.ts" },
  "admin-read": { contract: "experience-admin-read-api.openapi.json", output: "admin-read-openapi.ts" },
  "admin-support-case": { contract: "experience-admin-support-case-api.openapi.json", output: "admin-support-case-openapi.ts" },
  "admin-operations": { contract: "experience-admin-operations-api.openapi.json", output: "admin-operations-openapi.ts" },
  "host-support-history": { contract: "experience-host-support-history-api.openapi.json", output: "host-support-history-openapi.ts" },
  "host-support-settings": { contract: "experience-host-support-settings-api.openapi.json", output: "host-support-settings-openapi.ts" },
  "fee-summary": { contract: "experience-fee-summary-api.openapi.json", output: "fee-summary-openapi.ts" },
};

function outputPath(target: ContractTarget): string {
  return fileURLToPath(new URL(`../src/generated/${TARGETS[target].output}`, import.meta.url));
}

function header(target: ContractTarget): string {
  return [
    `// このファイルは scripts/gen-types.ts が contract/${TARGETS[target].contract} から生成する。手で編集しない。`,
    "// 更新: npm -C packages/api-client run gen:types",
    "",
  ].join("\n");
}

export async function generateContractTypes(target: ContractTarget = "public"): Promise<string> {
  const document = JSON.parse(await readFile(new URL(`../contract/${TARGETS[target].contract}`, import.meta.url), "utf8"));
  const ast = await openapiTS(document, { alphabetize: true, exportType: true });
  return `${header(target)}${astToString(ast)}`;
}

async function main(): Promise<void> {
  const check = process.argv.includes("--check");
  for (const target of Object.keys(TARGETS) as ContractTarget[]) {
    const generated = await generateContractTypes(target);
    const file = `src/generated/${TARGETS[target].output}`;
    if (check) {
      const committed = await readFile(outputPath(target), "utf8").catch(() => "");
      if (committed !== generated) {
        console.error(`${file} が契約と一致しません。npm -C packages/api-client run gen:types を実行してください。`);
        process.exitCode = 1;
        continue;
      }
      console.log(`OK: ${file} は契約と一致しています。`);
      continue;
    }
    await writeFile(outputPath(target), generated, "utf8");
    console.log(`wrote ${file}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
