import { open, rename } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

export async function atomicPrivateJson(path, value) {
  const parent = dirname(path);
  const temporary = join(parent, `.${basename(path)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  let file;
  try {
    file = await open(temporary, "wx", 0o600);
    await file.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await file.sync();
    await file.close();
    file = undefined;
    await rename(temporary, path);
    const directory = await open(parent, "r");
    try { await directory.sync(); } finally { await directory.close(); }
  } finally {
    await file?.close().catch(() => {});
  }
}
