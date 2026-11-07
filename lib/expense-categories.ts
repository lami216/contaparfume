import type {SqliteDatabase, SqliteSession} from "./sqlite.ts";

type Input=Record<string,unknown>;
const error=(message:string,status=400)=>Object.assign(new Error(message),{status});
export const expenseCategoryName=(name:unknown)=>typeof name==="string"?name.normalize("NFKC").trim().replace(/\s+/g," "):"";
export async function createExpenseCategory(db:SqliteDatabase,session:SqliteSession,input:Input){
  const name=expenseCategoryName(input.name),normalizedName=name.toLocaleLowerCase();
  if(!name||name.length>80)throw error("اسم فئة المصروف مطلوب ولا يتجاوز 80 حرفًا");
  const categories=await db.collection("expenseCategories").find({},{session}).toArray();
  if(categories.some(c=>expenseCategoryName(c.name).toLocaleLowerCase()===normalizedName))throw error("فئة المصروف موجودة بالفعل",409);
  const category={id:`expense-category-${crypto.randomUUID()}`,name,normalizedName,createdAt:new Date()};
  await db.collection("expenseCategories").insertOne(category,{session});
  return category.id;
}
/** An omitted field from an older client preserves the existing classification. */
export async function expenseCategorySnapshot(db:SqliteDatabase,session:SqliteSession,input:Input,original?:Input){
  if(!Object.hasOwn(input,"expenseCategoryId"))return{expenseCategoryId:original?.expenseCategoryId??null,expenseCategoryName:original?.expenseCategoryName??null};
  if(input.expenseCategoryId!==null&&typeof input.expenseCategoryId!=="string")throw error("فئة المصروف غير صالحة");
  const categoryId=String(input.expenseCategoryId??"").trim();
  if(!categoryId)return{expenseCategoryId:null,expenseCategoryName:null};
  const category=await db.collection("expenseCategories").findOne({id:categoryId},{session});
  if(!category)throw error("فئة المصروف غير موجودة",404);
  return{expenseCategoryId:category.id,expenseCategoryName:category.name};
}
