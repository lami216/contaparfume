import type {SqliteDatabase, SqliteSession} from "./sqlite.ts";
import {expenseCategoryKind, type ExpenseCategoryKind} from "../app/expense-category-kind.ts";
export {expenseCategoryKind, type ExpenseCategoryKind} from "../app/expense-category-kind.ts";

type Input=Record<string,unknown>;
const error=(message:string,status=400)=>Object.assign(new Error(message),{status});
export const expenseCategoryName=(name:unknown)=>typeof name==="string"?name.normalize("NFKC").trim().replace(/\s+/g," "):"";
const kindInput=(value:unknown):ExpenseCategoryKind=>{
  if(value===undefined)return "recurring";
  if(value!=="recurring"&&value!=="nonrecurring")throw error("نوع فئة المصروف غير صالح");
  return value;
};
function nameInput(value:unknown){
  const name=expenseCategoryName(value);
  if(!name||name.length>80)throw error("اسم فئة المصروف مطلوب ولا يتجاوز 80 حرفًا");
  return name;
}
async function assertUniqueName(db:SqliteDatabase,session:SqliteSession,name:string,exceptId?:string){
  const normalizedName=name.toLocaleLowerCase();
  const categories=await db.collection("expenseCategories").find({},{session}).toArray();
  const duplicate=categories.find(category=>category.id!==exceptId&&expenseCategoryName(category.name).toLocaleLowerCase()===normalizedName);
  if(duplicate)throw error(duplicate.isArchived===true?"اسم فئة المصروف مستخدم لفئة مؤرشفة؛ عدّل الفئة الموجودة أو اختر اسمًا آخر":"فئة المصروف موجودة بالفعل",409);
}
async function categoryFor(db:SqliteDatabase,session:SqliteSession,input:Input){
  const id=typeof input.id==="string"?input.id.trim():"";
  const category=id?await db.collection("expenseCategories").findOne({id},{session}):null;
  if(!category)throw error("فئة المصروف غير موجودة",404);
  const revision=category.revision===undefined?0:category.revision;
  if(!Number.isSafeInteger(revision)||revision<0)throw error("بيانات فئة المصروف غير صالحة؛ أعد تحميل الصفحة",409);
  if(input.expectedRevision!==undefined){
    if(typeof input.expectedRevision!=="number"||!Number.isSafeInteger(input.expectedRevision)||input.expectedRevision<0)throw error("إصدار فئة المصروف غير صالح");
    if(input.expectedRevision!==revision)throw error("تغيرت فئة المصروف؛ أعد تحميل الصفحة ثم حاول مجددًا",409);
  }
  return {category,revision,match:{id,...(category.revision===undefined?{revision:{$exists:false}}:{revision})}};
}
async function categoryAudit(db:SqliteDatabase,session:SqliteSession,action:string,before:Input|null,after:Input|null,disposition?:string){
  await db.collection("auditEvents").insertOne({id:`expense-category-audit-${crypto.randomUUID()}`,action,status:"committed",entityId:after?.id??before?.id,
    createdAt:new Date().toISOString(),before:before?structuredClone(before):null,after:after?structuredClone(after):null,...(disposition?{disposition}:{})},{session});
}
/** Runs in the command transaction; classification edits never replay expense invoices. */
export async function createExpenseCategory(db:SqliteDatabase,session:SqliteSession,input:Input){
  const name=nameInput(input.name),kind=kindInput(input.kind);
  await assertUniqueName(db,session,name);
  const category={id:`expense-category-${crypto.randomUUID()}`,name,normalizedName:name.toLocaleLowerCase(),kind,isArchived:false,revision:0,createdAt:new Date()};
  await db.collection("expenseCategories").insertOne(category,{session});
  await categoryAudit(db,session,"expense-category.create",null,category);
  return category.id;
}
export async function updateExpenseCategory(db:SqliteDatabase,session:SqliteSession,input:Input){
  const {category,revision,match}=await categoryFor(db,session,input);
  const name=nameInput(Object.hasOwn(input,"name")?input.name:category.name),kind=input.kind===undefined?expenseCategoryKind(category):kindInput(input.kind);
  await assertUniqueName(db,session,name,String(category.id));
  const normalizedName=name.toLocaleLowerCase();
  if(category.name===name&&category.kind===kind&&category.normalizedName===normalizedName)return String(category.id);
  const result=await db.collection("expenseCategories").updateOne(match,{$set:{name,normalizedName,kind,revision:revision+1,updatedAt:new Date()}},{session});
  if(!result.matchedCount)throw error("تغيرت فئة المصروف؛ أعد تحميل الصفحة ثم حاول مجددًا",409);
  const after=await db.collection("expenseCategories").findOne({id:category.id},{session});
  await categoryAudit(db,session,"expense-category.update",category,after);
  return String(category.id);
}
export async function deleteExpenseCategory(db:SqliteDatabase,session:SqliteSession,input:Input){
  const {category,revision,match}=await categoryFor(db,session,input);
  // Retain every historical reference, including voided documents and old numeric IDs.
  const references=await db.collection("documents").find({expenseCategoryId:{$exists:true}},{session,projection:{expenseCategoryId:1}}).toArray();
  const used=references.some(document=>String(document.expenseCategoryId)===String(category.id));
  if(used){
    if(category.isArchived===true)return{id:String(category.id),disposition:"archived" as const};
    const result=await db.collection("expenseCategories").updateOne(match,{$set:{isArchived:true,archivedAt:new Date(),updatedAt:new Date(),revision:revision+1}},{session});
    if(!result.matchedCount)throw error("تغيرت فئة المصروف؛ أعد تحميل الصفحة ثم حاول مجددًا",409);
    const after=await db.collection("expenseCategories").findOne({id:category.id},{session});
    await categoryAudit(db,session,"expense-category.delete",category,after,"archived");
    return{id:String(category.id),disposition:"archived" as const};
  }
  const result=await db.collection("expenseCategories").deleteOne(match,{session});
  if(!result.deletedCount)throw error("تغيرت فئة المصروف؛ أعد تحميل الصفحة ثم حاول مجددًا",409);
  await categoryAudit(db,session,"expense-category.delete",category,null,"deleted");
  return{id:String(category.id),disposition:"deleted" as const};
}
/** An omitted field from an older client preserves the existing classification. */
export async function expenseCategorySnapshot(db:SqliteDatabase,session:SqliteSession,input:Input,original?:Input){
  if(!Object.hasOwn(input,"expenseCategoryId"))return{expenseCategoryId:original?.expenseCategoryId??null,expenseCategoryName:original?.expenseCategoryName??null};
  if(input.expenseCategoryId!==null&&typeof input.expenseCategoryId!=="string")throw error("فئة المصروف غير صالحة");
  const categoryId=String(input.expenseCategoryId??"").trim();
  if(!categoryId)return{expenseCategoryId:null,expenseCategoryName:null};
  const category=await db.collection("expenseCategories").findOne({id:categoryId},{session});
  if(!category)throw error("فئة المصروف غير موجودة",404);
  const retained=String(original?.expenseCategoryId??"")===categoryId;
  if(category.isArchived===true&&!retained)throw error("فئة المصروف مؤرشفة؛ اختر فئة نشطة",409);
  if(retained)return{expenseCategoryId:categoryId,expenseCategoryName:original?.expenseCategoryName??category.name};
  return{expenseCategoryId:category.id,expenseCategoryName:category.name};
}
