import Database from "better-sqlite3";
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { SqliteDatabase } from "./sqlite.ts";

export type StockRecoverySafetyEvidence = { version: 1; kind: "sqlite"; context: string; fileName: string; sha256: string; bytes: number; createdAt: string };
export class StockRecoverySafetyError extends Error { status = 409; }
const message = "تعذر حفظ نسخة أمان موثقة لإصلاح المخزون؛ لم تُغيّر الأرصدة";
const contained = (root: string, path: string) => { const name = relative(root, path); return name !== "" && !name.startsWith("..") && !isAbsolute(name); };

/** Compare every application table, including uncommitted incoming restore rows. */
function logicalHash(db: Database.Database) {
  const hash = createHash("sha256");
  const tables = db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string; sql: string }>;
  for (const table of tables) {
    hash.update(JSON.stringify(table));
    const quoted = table.name.replaceAll('"', '""');
    for (const row of db.prepare(`SELECT * FROM "${quoted}" ORDER BY rowid`).iterate()) { hash.update(JSON.stringify(row)); hash.update("\n"); }
  }
  return hash.digest("hex");
}
function hashFile(path: string) {
  const hash = createHash("sha256"), buffer = Buffer.allocUnsafe(64 * 1024), file = openSync(path, "r"); let bytes = 0;
  try { for (;;) { const length = readSync(file, buffer, 0, buffer.length, null); if (!length) break; hash.update(buffer.subarray(0, length)); bytes += length; } }
  finally { closeSync(file); }
  return { sha256: hash.digest("hex"), bytes };
}

/** Called once inside the repair transaction, before any product/movement write.
 * The private copy is standalone SQLite; no raw file/WAL copying or header edits. */
export function createStockRecoverySafetySnapshot(db: SqliteDatabase, options: { context: string }): StockRecoverySafetyEvidence {
  let temporary: string | undefined;
  let temporaryOwned = false;
  try {
    if (!db.native.inTransaction || db.native.memory || !db.native.name || db.native.name === ":memory:") throw new StockRecoverySafetyError(message);
    const dataDirectory = realpathSync(dirname(resolve(db.native.name))), directory = join(dataDirectory, "stock-recovery");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (lstatSync(directory).isSymbolicLink() || !contained(dataDirectory, realpathSync(directory))) throw new StockRecoverySafetyError(message);
    // Keep names short: SQLite's Windows VFS can reject paths accepted by Node.
    const fileName = `s${randomBytes(8).toString("hex")}.db`, final = join(directory, fileName);
    temporary = join(directory, `.${fileName}.tmp`);
    if (!contained(directory, temporary) || !contained(directory, final) || existsSync(final)) throw new StockRecoverySafetyError(message);
    const expected = logicalHash(db.native), serialized = db.native.serialize();
    const file = openSync(/* turbopackIgnore: true */ temporary, "wx", 0o600);
    temporaryOwned = true;
    try { let written = 0; while (written < serialized.length) { const length = writeSync(file, serialized, written, serialized.length - written); if (length <= 0) throw new StockRecoverySafetyError(message); written += length; } fsyncSync(file); }
    finally { closeSync(file); }
    if (hashFile(temporary).sha256 !== createHash("sha256").update(serialized).digest("hex")) throw new StockRecoverySafetyError(message);
    const copy = new Database(temporary, { fileMustExist: true });
    try {
      copy.pragma("synchronous = FULL");
      if (copy.pragma("journal_mode = DELETE", { simple: true }) !== "delete" || copy.pragma("quick_check", { simple: true }) !== "ok" || logicalHash(copy) !== expected) throw new StockRecoverySafetyError(message);
    } finally { copy.close(); }
    const flushed = openSync(/* turbopackIgnore: true */ temporary, "r+"); try { fsyncSync(flushed); } finally { closeSync(flushed); }
    const evidence = hashFile(temporary);
    if (existsSync(final)) throw new StockRecoverySafetyError(message);
    renameSync(temporary, final); temporary = undefined; temporaryOwned = false;
    if (hashFile(final).sha256 !== evidence.sha256) throw new StockRecoverySafetyError(message);
    return { version: 1, kind: "sqlite", context: options.context, fileName: basename(final), ...evidence, createdAt: new Date().toISOString() };
  } catch {
    // Only an exclusively created, contained temporary copy may be removed.
    if (temporaryOwned && temporary && existsSync(/* turbopackIgnore: true */ temporary)) { try { unlinkSync(temporary); } catch { /* Preserve an unusable partial copy if the OS still holds it. */ } }
    throw new StockRecoverySafetyError(message);
  }
}
