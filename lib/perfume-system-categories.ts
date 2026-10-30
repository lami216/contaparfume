import type { SqliteDatabase as Db, SqliteSession as Session } from "./sqlite.ts";

export const PERFUME_SYSTEM_CATEGORIES = [
  { id: "system:perfume:decants", systemKind: "perfume-decants", name: "التقسيمات", perfumeForm: "decant" },
  { id: "system:perfume:bottles", systemKind: "perfume-bottles", name: "زجاج التقسيمات", perfumeForm: "bottle" },
] as const;
export type PerfumeSystemCategoryKind = typeof PERFUME_SYSTEM_CATEGORIES[number]["systemKind"];
type Row = Record<string, unknown>;
const text = (value: unknown) => typeof value === "string" ? value.trim() : "";
const fail = (message: string, status = 409) => Object.assign(new Error(message), { status });

/** Reserved identity is authoritative; client-supplied systemKind is never trusted. */
export function perfumeSystemCategoryKind(categoryId: unknown): PerfumeSystemCategoryKind | null {
  return PERFUME_SYSTEM_CATEGORIES.find(category => category.id === categoryId)?.systemKind ?? null;
}
export function perfumeSystemCategoryId(perfumeForm: unknown): string | null {
  return PERFUME_SYSTEM_CATEGORIES.find(category => category.perfumeForm === perfumeForm)?.id ?? null;
}
export function assertPerfumeCategoryCanBeDeleted(categoryId: unknown) {
  if (perfumeSystemCategoryKind(categoryId)) throw fail("هذه فئة تلقائية للتقسيمات؛ يمكنك تغيير اسمها ولا يمكن حذفها");
}

async function initialSystemCategoryName(db: Db, session: Session | undefined, preferred: string) {
  const categories = await db.collection("productCategories").find({}, { session, projection: { name: 1 } }).toArray();
  const names = new Set(categories.map(category => text(category.name).toLocaleLowerCase()));
  let candidate = preferred, suffix = 0;
  while (names.has(candidate.toLocaleLowerCase())) {
    suffix += 1;
    candidate = `${preferred} (تلقائية${suffix > 1 ? ` ${suffix}` : ""})`;
  }
  return candidate;
}

/** Category-only metadata repair. Never rewrite stock, lots or historical documents. */
export async function ensurePerfumeSystemCategories(db: Db, session?: Session) {
  for (const definition of PERFUME_SYSTEM_CATEGORIES) {
    const existing = await db.collection("productCategories").findOne({ id: definition.id }, { session });
    if (!existing) {
      await db.collection("productCategories").insertOne({ id: definition.id, name: await initialSystemCategoryName(db, session, definition.name), systemKind: definition.systemKind, createdAt: new Date() }, { session });
      continue;
    }
    const patch: Row = {};
    if (existing.systemKind !== definition.systemKind) patch.systemKind = definition.systemKind;
    if (!text(existing.name)) patch.name = await initialSystemCategoryName(db, session, definition.name);
    if (Object.keys(patch).length) await db.collection("productCategories").updateOne({ id: definition.id }, { $set: patch }, { session });
  }
  const reserved = PERFUME_SYSTEM_CATEGORIES.map(category => category.id);
  const products = await db.collection("products").find({ $or: [{ perfumeForm: { $in: ["decant", "bottle"] } }, { categoryId: { $in: reserved } }] }, { session }).toArray();
  for (const product of products) {
    let categoryId = perfumeSystemCategoryId(product.perfumeForm);
    if (!categoryId && product.perfumeForm === "partial") {
      const source = await db.collection("products").findOne({ id: text(product.parentProductId) }, { session });
      const sourceCategory = text(source?.categoryId);
      if (sourceCategory && !perfumeSystemCategoryKind(sourceCategory) && await db.collection("productCategories").findOne({ id: sourceCategory }, { session })) categoryId = sourceCategory;
    }
    if (product.categoryId !== categoryId) await db.collection("products").updateOne({ id: product.id }, { $set: { categoryId } }, { session });
  }
}

/** Product classification follows stored form, never a form supplied by the request. */
export async function resolvePerfumeProductCategory(db: Db, session: Session, product: Row | null, requested: unknown): Promise<string | null> {
  const required = perfumeSystemCategoryId(product?.perfumeForm), categoryId = text(requested);
  if (required) {
    if (requested !== undefined && categoryId !== required) throw fail("فئة هذا المنتج تلقائية بحسب نوعه؛ لا يمكن نقله إلى فئة أخرى");
    await ensurePerfumeSystemCategories(db, session);
    return required;
  }
  if (perfumeSystemCategoryKind(categoryId)) throw fail("هذه الفئة مخصصة تلقائيًا للتقسيمات أو زجاجها؛ اختر فئة عادية للمنتج");
  if (categoryId && !await db.collection("productCategories").findOne({ id: categoryId }, { session })) throw fail("الفئة غير موجودة", 404);
  return categoryId || null;
}
