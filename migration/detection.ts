import { parseAndValidateBackup } from "../lib/backup.ts";
import { dataAccAdapter } from "../legacy/dataacc-sqlite.ts";
export type DetectionResult={kind:"conta-backup"|"external"|"unknown";sourceType:"conta-backup"|"dataacc-sqlite"|"generic-sqlite"|"unknown";label:string;needsManualMapping:boolean};
export async function detectImportFile(bytes:Uint8Array):Promise<DetectionResult>{
 try{parseAndValidateBackup(new TextDecoder().decode(bytes));return{kind:"conta-backup",sourceType:"conta-backup",label:"نسخة الكرنه",needsManualMapping:false}}catch{}
 if(await dataAccAdapter.detect(bytes)){const pkg=await dataAccAdapter.inspect(bytes);const recognized=Object.values(pkg.entities).some(values=>values.length>0);return recognized?{kind:"external",sourceType:"dataacc-sqlite",label:"DataAcc SQLite",needsManualMapping:false}:{kind:"unknown",sourceType:"generic-sqlite",label:"مصدر SQLite غير معروف — يحتاج تعيينًا يدويًا",needsManualMapping:true}}
 return{kind:"unknown",sourceType:"unknown",label:"مصدر غير معروف — يحتاج تعيينًا يدويًا",needsManualMapping:true};
}
