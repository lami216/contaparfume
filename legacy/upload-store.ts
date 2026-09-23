import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { detectLegacyDatabase } from "./dataacc-sqlite.ts";

export const LEGACY_CHUNK_BYTES = 512 * 1024;
export const LEGACY_UPLOAD_MAX_AGE_MS = 24 * 60 * 60 * 1000;
// The upload is staging for a resumable import, not a disposable request temp file.
// Desktop sets ALKARNA_USER_DATA to Electron's userData directory.
const root = join(process.env.ALKARNA_USER_DATA || join(process.cwd(), ".dev-data"), "legacy-import-staging");
type Meta = { id: string; size: number; chunks: number; nextIndex: number; createdAt: number };
const validId = (id: string) => /^[0-9a-f-]{36}$/.test(id);
const paths = (id: string) => { if (!validId(id)) throw new Error("معرف الرفع غير صالح"); return { meta: join(root, `${id}.json`), data: join(root, `${id}.sqlite`) }; };
async function readMeta(id: string) { return JSON.parse(await readFile(/* turbopackIgnore: true */ paths(id).meta, "utf8")) as Meta; }
async function cleanupAbandoned() { await mkdir(root, { recursive: true }); const { readdir } = await import("node:fs/promises"); for (const name of await readdir(root)) { const path = join(root, name); try { if (Date.now() - (await stat(path)).mtimeMs > LEGACY_UPLOAD_MAX_AGE_MS) await rm(path, { force: true }); } catch {} } }
export async function startLegacyUpload(size: number) {
  await cleanupAbandoned();
  if (!Number.isSafeInteger(size) || size <= 0) throw new Error("حجم ملف SQLite غير صالح");
  const chunks = Math.ceil(size / LEGACY_CHUNK_BYTES);
  const id = randomUUID(), p = paths(id), meta: Meta = { id, size, chunks, nextIndex: 0, createdAt: Date.now() };
  await mkdir(root, { recursive: true }); await writeFile(p.meta, JSON.stringify(meta), { flag: "wx", mode: 0o600 }); await writeFile(p.data, new Uint8Array(), { flag: "wx", mode: 0o600 });
  return { uploadId: id, chunkSize: LEGACY_CHUNK_BYTES, chunks };
}
export async function appendLegacyChunk(id: string, index: number, bytes: Uint8Array) {
  const meta = await readMeta(id);
  if (!Number.isInteger(index) || index !== meta.nextIndex || index >= meta.chunks) throw new Error("أجزاء الملف مفقودة أو وصلت بترتيب غير صالح");
  const expected = index === meta.chunks - 1 ? meta.size - index * LEGACY_CHUNK_BYTES : LEGACY_CHUNK_BYTES;
  if (!bytes.length || bytes.length > LEGACY_CHUNK_BYTES || bytes.length !== expected) throw new Error("حجم جزء الملف غير صالح");
  const handle = await open(/* turbopackIgnore: true */ paths(id).data, "a", 0o600); try { await handle.write(bytes); } finally { await handle.close(); }
  meta.nextIndex++; await writeFile(paths(id).meta, JSON.stringify(meta), { mode: 0o600 }); return { received: meta.nextIndex };
}
export async function finishLegacyUpload(id: string) {
  const meta = await readMeta(id), p = paths(id);
  if (meta.nextIndex !== meta.chunks || (await stat(/* turbopackIgnore: true */ p.data)).size !== meta.size) throw new Error("أجزاء الملف غير مكتملة");
  const bytes = new Uint8Array(await readFile(/* turbopackIgnore: true */ p.data)); if (!detectLegacyDatabase(bytes)) throw new Error("الملف ليس قاعدة SQLite 3"); return bytes;
}
export async function removeLegacyUpload(id: string) { const p = paths(id); await Promise.all([rm(p.meta, { force: true }), rm(p.data, { force: true })]); }
