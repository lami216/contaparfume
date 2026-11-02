import type { SqliteDatabase as Db, SqliteSession as Session } from "./sqlite.ts";

export const PERFUME_SYSTEM_CATEGORIES = [
  { id: "system:perfume:decants", systemKind: "perfume-decants", name: "التقسيمات", perfumeForm: "decant" },
  { id: "system:perfume:bottles", systemKind: "perfume-bottles", name: "زجاج التقسيمات", perfumeForm: "bottle" },
] as const;
export const FRAGRANCE_DEFAULT_CATEGORY = { id: "system:perfume:fragrances", systemKind: "perfume-fragrances", name: "العطور" } as const;
const FRAGRANCE_SETTING_ID = "perfume-fragrance-category";
export type PerfumeSystemCategoryKind = typeof PERFUME_SYSTEM_CATEGORIES[number]["systemKind"] | typeof FRAGRANCE_DEFAULT_CATEGORY.systemKind;
type Row = Record<string, unknown>;
const text = (value: unknown) => typeof value === "string" ? value.trim() : "";
const fail = (message: string, status = 409) => Object.assign(new Error(message), { status });

/** Reserved identities and the trusted default designation are authoritative;
 * client-supplied systemKind is never trusted. */
export function perfumeSystemCategoryKind(categoryId: unknown, fragranceCategoryId?: string): PerfumeSystemCategoryKind | null {
  if (categoryId === (fragranceCategoryId ?? FRAGRANCE_DEFAULT_CATEGORY.id)) return FRAGRANCE_DEFAULT_CATEGORY.systemKind;
  return PERFUME_SYSTEM_CATEGORIES.find(category => category.id === categoryId)?.systemKind ?? null;
}
export function perfumeSystemCategoryId(perfumeForm: unknown): string | null {
  return PERFUME_SYSTEM_CATEGORIES.find(category => category.perfumeForm === perfumeForm)?.id ?? null;
}
export function assertPerfumeCategoryCanBeDeleted(categoryId: unknown, fragranceCategoryId?: string) {
  if (perfumeSystemCategoryKind(categoryId, fragranceCategoryId)) throw fail("هذه فئة تلقائية؛ يمكنك تغيير اسمها ولا يمكن حذفها");
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
  const categories = await db.collection("productCategories").find({}, { session }).toArray();
  const designation = await db.collection("appSettings").findOne({ _id: FRAGRANCE_SETTING_ID }, { session });
  // The designation is server-owned. A category's client/imported systemKind
  // alone can never adopt it or gain protected privileges.
  let fragrance = categories.find(category => category.id === designation?.categoryId && !reserved.includes(String(category.id) as typeof reserved[number]));
  fragrance ??= categories.find(category => category.id === FRAGRANCE_DEFAULT_CATEGORY.id);
  fragrance ??= categories.find(category => !reserved.includes(String(category.id) as typeof reserved[number]) && text(category.name).toLocaleLowerCase() === FRAGRANCE_DEFAULT_CATEGORY.name);
  if (!fragrance) {
    fragrance = { id: FRAGRANCE_DEFAULT_CATEGORY.id, name: await initialSystemCategoryName(db, session, FRAGRANCE_DEFAULT_CATEGORY.name), systemKind: FRAGRANCE_DEFAULT_CATEGORY.systemKind, createdAt: new Date() };
    await db.collection("productCategories").insertOne(fragrance, { session });
    categories.push(fragrance);
  }
  const fragranceCategoryId = String(fragrance.id);
  const patch: Row = {};
  if (fragrance.systemKind !== FRAGRANCE_DEFAULT_CATEGORY.systemKind) patch.systemKind = FRAGRANCE_DEFAULT_CATEGORY.systemKind;
  if (!text(fragrance.name)) patch.name = await initialSystemCategoryName(db, session, FRAGRANCE_DEFAULT_CATEGORY.name);
  if (Object.keys(patch).length) await db.collection("productCategories").updateOne({ id: fragranceCategoryId }, { $set: patch }, { session });
  if (designation?.categoryId !== fragranceCategoryId) await db.collection("appSettings").updateOne({ _id: FRAGRANCE_SETTING_ID }, { $set: { categoryId: fragranceCategoryId } }, { session, upsert: true });
  const categoryIds = new Set(categories.map(category => String(category.id)));
  const products = await db.collection("products").find({}, { session }).toArray();
  const productsById = new Map(products.map(product => [String(product.id), product]));
  for (const product of products) {
    let categoryId = perfumeSystemCategoryId(product.perfumeForm);
    const storedCategory = text(product.categoryId);
    if (!categoryId && storedCategory && !reserved.includes(storedCategory as typeof reserved[number])) {
      if (!categoryIds.has(storedCategory)) throw fail(`المنتج ${text(product.name) || String(product.id)} يشير إلى فئة غير موجودة؛ راجع التصنيف قبل المتابعة`);
      categoryId = storedCategory;
    }
    if (!categoryId && product.perfumeForm === "partial") {
      const source = productsById.get(text(product.parentProductId));
      const sourceCategory = text(source?.categoryId);
      if (sourceCategory && !reserved.includes(sourceCategory as typeof reserved[number]) && categoryIds.has(sourceCategory)) categoryId = sourceCategory;
    }
    categoryId ??= fragranceCategoryId;
    if (product.categoryId !== categoryId) await db.collection("products").updateOne({ id: product.id }, { $set: { categoryId } }, { session });
  }
  return { fragranceCategoryId };
}

/** Product classification follows stored form, never a form supplied by the request. */
export async function resolvePerfumeProductCategory(db: Db, session: Session, product: Row | null, requested: unknown): Promise<string | null> {
  if (requested != null && typeof requested !== "string") throw fail("اختر فئة منتج صالحة", 400);
  const { fragranceCategoryId } = await ensurePerfumeSystemCategories(db, session);
  const required = perfumeSystemCategoryId(product?.perfumeForm);
  const current = product?.id ? await db.collection("products").findOne({ id: product.id }, { session }) : product;
  const categoryId = text(requested === undefined ? current?.categoryId : requested);
  if (required) {
    if (requested !== undefined && categoryId !== required) throw fail("فئة هذا المنتج تلقائية بحسب نوعه؛ لا يمكن نقله إلى فئة أخرى");
    return required;
  }
  if (PERFUME_SYSTEM_CATEGORIES.some(category => category.id === categoryId)) throw fail("هذه الفئة مخصصة تلقائيًا للتقسيمات أو زجاجها؛ اختر فئة عادية للمنتج");
  if (categoryId && !await db.collection("productCategories").findOne({ id: categoryId }, { session })) throw fail("الفئة غير موجودة", 404);
  return categoryId || fragranceCategoryId;
}
