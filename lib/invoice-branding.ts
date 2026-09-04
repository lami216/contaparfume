import type { SqliteDatabase as Db } from "./sqlite.ts";
import { invoiceFonts, type InvoiceBrandingSettings, type InvoiceFont } from "../app/domain.ts";
import { APP_NAME } from "./app-brand.ts";
export const INVOICE_BRANDING_ID = "invoice-branding";
export const DEFAULT_INVOICE_BRANDING: InvoiceBrandingSettings = { storeName: APP_NAME, storePhone: "", storeAddress: "", registrationNumber: "", taxNumber: "", footerNote: "", nameFont: "tahoma", nameFontSize: 24, nameFontWeight: 800 };
export const invoiceFontFamilies: Record<InvoiceFont,string> = { tahoma: "Tahoma, sans-serif", arial: "Arial, sans-serif", "segoe-ui": "'Segoe UI', sans-serif", "times-new-roman": "'Times New Roman', serif" };
export function validateInvoiceBranding(value: unknown): InvoiceBrandingSettings {
  const body=value as Record<string,unknown>|null,storeName=String(body?.storeName??"").trim();
  if(!storeName||storeName.length>80)throw new Error("اسم المحل مطلوب ويجب ألا يتجاوز 80 حرفًا");
  if(!invoiceFonts.includes(body?.nameFont as InvoiceFont))throw new Error("نوع الخط غير صالح");
  const nameFontSize=Number(body?.nameFontSize);if(!Number.isFinite(nameFontSize)||nameFontSize<16||nameFontSize>32)throw new Error("حجم اسم المحل يجب أن يكون بين 16 و32");
  const nameFontWeight=Number(body?.nameFontWeight);if(![400,600,800].includes(nameFontWeight))throw new Error("سماكة الخط غير صالحة");
  const optional=(key:string,max:number)=>{const result=String(body?.[key]??"").trim();if(result.length>max)throw new Error("إحدى معلومات النشاط أطول من الحد المسموح");return result};
  return{storeName,storePhone:optional("storePhone",40),storeAddress:optional("storeAddress",160),registrationNumber:optional("registrationNumber",60),taxNumber:optional("taxNumber",60),footerNote:optional("footerNote",160),nameFont:body!.nameFont as InvoiceFont,nameFontSize,nameFontWeight:nameFontWeight as 400|600|800};
}
export async function getInvoiceBranding(db:Db){const value=await db.collection<{_id:string;[key:string]:unknown}>("appSettings").findOne({_id:INVOICE_BRANDING_ID});if(!value)return DEFAULT_INVOICE_BRANDING;try{return validateInvoiceBranding(value)}catch{return DEFAULT_INVOICE_BRANDING}}
export async function saveInvoiceBranding(db:Db,value:unknown){const branding=validateInvoiceBranding(value);await db.collection<{_id:string;[key:string]:unknown}>("appSettings").updateOne({_id:INVOICE_BRANDING_ID},{$set:{...branding,schemaVersion:1,updatedAt:new Date()}},{upsert:true});return branding}
