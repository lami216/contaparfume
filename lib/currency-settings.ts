import type { SqliteDatabase as Db } from "./sqlite.ts";
import { DEFAULT_CURRENCY_CODE, MAX_CURRENCY_CODES, defaultCurrencySettings, normalizeCurrencyCode, normalizeCurrencySettings, type CurrencySettings } from "./currency-core.ts";

export const CURRENCY_SETTINGS_ID = "currency-settings";

export function validateCurrencySettings(value: unknown): CurrencySettings {
  const body=value&&typeof value==="object"?value as Record<string,unknown>:{};
  const code=normalizeCurrencyCode(body.code);
  if(!code)throw new Error("رمز العملة يجب أن يتكون من 3 أحرف إنجليزية");
  if(!Array.isArray(body.availableCodes))throw new Error("قائمة العملات غير صالحة");
  if(body.availableCodes.length>MAX_CURRENCY_CODES)throw new Error("عدد العملات المحفوظة كبير جدًا");
  const availableCodes:string[]=[];
  for(const raw of body.availableCodes){const normalized=normalizeCurrencyCode(raw);if(!normalized)throw new Error("قائمة العملات غير صالحة");if(!availableCodes.includes(normalized))availableCodes.push(normalized)}
  if(!availableCodes.includes(DEFAULT_CURRENCY_CODE))availableCodes.unshift(DEFAULT_CURRENCY_CODE);
  if(!availableCodes.includes(code))availableCodes.push(code);
  return {code,availableCodes};
}

export async function getCurrencySettings(db:Db) {
  const value=await db.collection<{_id:string;[key:string]:unknown}>("appSettings").findOne({_id:CURRENCY_SETTINGS_ID});
  return value?normalizeCurrencySettings(value):defaultCurrencySettings();
}

export async function saveCurrencySettings(db:Db,value:unknown) {
  const currency=validateCurrencySettings(value);
  await db.collection<{_id:string;[key:string]:unknown}>("appSettings").updateOne({_id:CURRENCY_SETTINGS_ID},{$set:{...currency,schemaVersion:1,updatedAt:new Date()}},{upsert:true});
  return currency;
}
