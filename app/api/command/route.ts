import { requireValidLicense } from "../../../lib/license.ts";
import type { SqliteSession as ClientSession, SqliteDatabase as Db } from "../../../lib/sqlite.ts";
import { getDatabase } from "../../../lib/sqlite.ts";
import { log } from "../../../lib/log.ts";
import { requireCapability, validSameOrigin, type Capability } from "../../../lib/auth.ts";
import { PerfumeInvoiceCommandError } from "../../perfume-invoice-commands.ts";
import { execute as executeBaseCommand } from "./base-route.ts";

type Input = Record<string, unknown>;
class CommandError extends Error { status: number; constructor(message: string, status = 400) { super(message); this.status = status; } }
const id = (prefix: string) => `${prefix}-${crypto.randomUUID()}`;
const text = (value: unknown) => typeof value === "string" ? value.trim() : "";

export async function execute(db: Db, session: ClientSession, body: Input) {
  const type = text(body.type);
  if (type === "product-category.create" || type === "product-category.update") {
    const categoryId = text(body.id), name = text(body.name);
    if (!name) throw new CommandError("اسم الفئة مطلوب");
    if (name.length > 80) throw new CommandError("اسم الفئة طويل جدًا");
    const categories = await db.collection("productCategories").find({}, { session, projection: { id: 1, name: 1 } }).toArray();
    const normalized = name.toLocaleLowerCase();
    const duplicate = categories.some(category => String(category.name ?? "").trim().toLocaleLowerCase() === normalized && (type !== "product-category.update" || String(category.id) !== categoryId));
    if (duplicate) throw new CommandError("هذه الفئة موجودة بالفعل", 409);
    if (type === "product-category.update") {
      if (!categoryId) throw new CommandError("الفئة غير موجودة", 404);
      const result = await db.collection("productCategories").updateOne({ id: categoryId }, { $set: { name, updatedAt: new Date() } }, { session });
      if (!result.matchedCount) throw new CommandError("الفئة غير موجودة", 404);
      return categoryId;
    }
    const category = { id: id("category"), name, createdAt: new Date() };
    await db.collection("productCategories").insertOne(category, { session });
    return category.id;
  }
  if (type === "product-category.delete") {
    const categoryId = text(body.id);
    const category = categoryId ? await db.collection("productCategories").findOne({ id: categoryId }, { session }) : null;
    if (!category) throw new CommandError("الفئة غير موجودة", 404);
    await db.collection("products").updateMany({ categoryId }, { $set: { categoryId: null } }, { session });
    await db.collection("productCategories").deleteOne({ id: categoryId }, { session });
    return categoryId;
  }
  return executeBaseCommand(db, session, body);
}

export async function POST(request: Request) {
  const licenseDenied = await requireValidLicense();
  if (licenseDenied) return licenseDenied;
  let type = "unknown";
  try {
    const body = await request.json() as Input;
    type = text(body.type);
    const map: Record<string, Capability> = {
      "product.delete":"products.delete","product.restore":"products.edit","product.create":"products.create","product.update":"products.edit",
      "product-category.create":"products.create","product-category.update":"products.edit","product-category.delete":"products.delete",
      "warehouse.create":"warehouses.create","warehouse.update":"warehouses.edit","warehouse.default":"warehouses.edit","warehouse.delete":"warehouses.delete",
      "sale.post":"pos.create","sale.update":"pos.edit","sale.void":"pos.delete","purchase.post":"purchases.create","purchase.update":"purchases.edit","purchase.void":"purchases.delete",
      "perfume-bottle.create":"perfume.divisions.manage","decant-sale.post":"perfume.divisions.manage","decant-sale.void":"perfume.divisions.manage","decant-purchase.post":"perfume.divisions.manage","decant-purchase.void":"perfume.divisions.manage","perfume-split.post":"perfume.divisions.manage","perfume-recombine.post":"perfume.divisions.manage",
      "transfer.post":"warehouses.transfer","adjustment.post":"warehouses.adjust",
      "payment.post":text(body.side)==="receivable"?"customers.collect":"suppliers.pay","party-cash.post":text(body.partyType)==="supplier"?"suppliers.pay":"customers.collect","settlement.post":"customers.edit","offset.post":"customers.edit",
      "expense.post":"expenses.create","expense.update":"expenses.edit","expense.void":"expenses.delete",
      "payment-account.create":"banks.create","payment-account.update":"banks.edit","payment-account.delete":"banks.delete","payment-account.restore":"banks.edit","account-adjustment.post":"banks.deposit_withdraw","account-transfer.post":"banks.transfer","account-opening-balance-correction.post":"banks.balance_correct",
      "party.create":body.partyType==="customer"?"customers.create":"suppliers.create",
    };
    const capability = map[type];
    if (!capability) return Response.json({ error: "العملية غير مدعومة" }, { status: 400 });
    const denied = await requireCapability(request, capability);
    if (denied) return denied;
    if (!validSameOrigin(request)) return Response.json({ error: "طلب غير صالح" }, { status: 403 });
    const idempotencyKey = text(request.headers.get("Idempotency-Key"));
    if (!idempotencyKey || idempotencyKey.length > 200) return Response.json({ error: "مفتاح العملية مطلوب" }, { status: 400 });
    const fingerprint = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(body)))).toString("hex");
    const db = await getDatabase(), receipts = db.collection("commandReceipts"), prior = await receipts.findOne({ _id: idempotencyKey as never });
    if (prior) {
      if (prior.fingerprint !== fingerprint) return Response.json({ error: "مفتاح العملية مستخدم لطلب مختلف" }, { status: 409 });
      if (prior.status === "committed") return Response.json(prior.result);
      return Response.json({ error: "العملية قيد التنفيذ" }, { status: 409 });
    }
    let result: unknown = "", response: unknown;
    try {
      await db.transaction(async session => {
        await receipts.insertOne({ _id: idempotencyKey as never, commandType: type, fingerprint, status: "processing", createdAt: new Date() }, { session });
        await db.collection("auditEvents").insertOne({ id: id("audit"), action: type, status: "started", createdAt: new Date() }, { session });
        result = await execute(db, session, body);
        response = typeof result === "object" && result ? result : { id: result };
        await db.collection("auditEvents").insertOne({ id: id("audit"), action: type, entityId: typeof result === "object" && result ? (result as { id?: unknown }).id : result, status: "committed", createdAt: new Date() }, { session });
        await receipts.updateOne({ _id: idempotencyKey as never }, { $set: { status: "committed", result: response, committedAt: new Date() } }, { session });
      });
    } catch (error) {
      if ((error as { code?: number }).code === 11000) {
        const duplicate = await receipts.findOne({ _id: idempotencyKey as never });
        if (duplicate?.fingerprint !== fingerprint) return Response.json({ error: "مفتاح العملية مستخدم لطلب مختلف" }, { status: 409 });
        if (duplicate?.status === "committed") return Response.json(duplicate.result);
        return Response.json({ error: "العملية قيد التنفيذ" }, { status: 409 });
      }
      throw error;
    }
    log("info", "api.command.completed", { commandType: type, entityId: result });
    return Response.json(response);
  } catch (error) {
    const status = error instanceof CommandError || error instanceof PerfumeInvoiceCommandError
      ? error.status
      : typeof (error as { status?: unknown })?.status === "number"
        ? Number((error as { status: number }).status)
        : 500;
    const message = status !== 500 && error instanceof Error ? error.message : "تعذر تنفيذ العملية";
    log("error", "api.command.failed", { commandType: type, error });
    return Response.json({ error: message }, { status });
  }
}
