import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { detectLegacyDatabase, MAX_LEGACY_BYTES } from "./dataacc-sqlite.ts";

export const LEGACY_CHUNK_BYTES = 512 * 1024;
export const MAX_LEGACY_CHUNKS = Math.ceil(MAX_LEGACY_BYTES / LEGACY_CHUNK_BYTES);
export const LEGACY_UPLOAD_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const root = join(tmpdir(), "conta-legacy-uploads");
type Meta = { id: string; size: number; chunks: number; nextIndex: number; createdAt: number };
const validId = (id: string) => /^[0-9a-f-]{36}$/.test(id);
const paths = (id: string) => { if (!validId(id)) throw new Error("معرف الرفع غير صالح"); return { meta: join(root, `${id}.json`), data: join(root, `${id}.sqlite`) }; };
async function readMeta(id: string) { return JSON.parse(await readFile(paths(id).meta, "utf8")) as Meta; }
async function cleanupAbandoned() { await mkdir(root, { recursive: true }); const { readdir } = await import("node:fs/promises"); for (const name of await readdir(root)) { const path = join(root, name); try { if (Date.now() - (await stat(path)).mtimeMs > LEGACY_UPLOAD_MAX_AGE_MS) await rm(path, { force: true }); } catch {} } }
export async function startLegacyUpload(size: number) {
  await cleanupAbandoned();
  if (!Number.isInteger(size) || size <= 0 || size > MAX_LEGACY_BYTES) throw new Error("حجم ملف SQLite غير صالح أو أكبر من الحد المسموح");
  const chunks = Math.ceil(size / LEGACY_CHUNK_BYTES); if (chunks > MAX_LEGACY_CHUNKS) throw new Error("عدد أجزاء الملف أكبر من الحد المسموح");
  const id = randomUUID(), p = paths(id), meta: Meta = { id, size, chunks, nextIndex: 0, createdAt: Date.now() };
  await mkdir(root, { recursive: true }); await writeFile(p.meta, JSON.stringify(meta), { flag: "wx", mode: 0o600 }); await writeFile(p.data, new Uint8Array(), { flag: "wx", mode: 0o600 });
  return { uploadId: id, chunkSize: LEGACY_CHUNK_BYTES, chunks };
}
export async function appendLegacyChunk(id: string, index: number, bytes: Uint8Array) {
  const meta = await readMeta(id);
  if (!Number.isInteger(index) || index !== meta.nextIndex || index >= meta.chunks) throw new Error("أجزاء الملف مفقودة أو وصلت بترتيب غير صالح");
  const expected = index === meta.chunks - 1 ? meta.size - index * LEGACY_CHUNK_BYTES : LEGACY_CHUNK_BYTES;
  if (!bytes.length || bytes.length > LEGACY_CHUNK_BYTES || bytes.length !== expected) throw new Error("حجم جزء الملف غير صالح");
  const handle = await open(paths(id).data, "a", 0o600); try { await handle.write(bytes); } finally { await handle.close(); }
  meta.nextIndex++; await writeFile(paths(id).meta, JSON.stringify(meta), { mode: 0o600 }); return { received: meta.nextIndex };
}
export async function finishLegacyUpload(id: string) {
  const meta = await readMeta(id), p = paths(id);
  if (meta.nextIndex !== meta.chunks || (await stat(p.data)).size !== meta.size) throw new Error("أجزاء الملف غير مكتملة");
  const bytes = new Uint8Array(await readFile(p.data)); if (!detectLegacyDatabase(bytes)) throw new Error("الملف ليس قاعدة SQLite 3"); return bytes;
}
export async function removeLegacyUpload(id: string) { const p = paths(id); await Promise.all([rm(p.meta, { force: true }), rm(p.data, { force: true })]); }
