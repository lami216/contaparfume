import { getPrincipalFromRequest, validSameOrigin } from "../../../../lib/auth.ts";
import { installLicense, LicenseError, MAX_LICENSE_BYTES } from "../../../../lib/license.ts";
export const runtime="nodejs";
export async function POST(request:Request){
  if(!await getPrincipalFromRequest(request))return Response.json({error:"غير مصرح"},{status:401});
  if(!validSameOrigin(request))return Response.json({error:"طلب غير صالح"},{status:403});
  const length=Number(request.headers.get("content-length")??0);if(length>MAX_LICENSE_BYTES)return Response.json({error:"ملف الترخيص أكبر من الحد المسموح"},{status:413});
  try{const bytes=new Uint8Array(await request.arrayBuffer());if(bytes.byteLength>MAX_LICENSE_BYTES)return Response.json({error:"ملف الترخيص أكبر من الحد المسموح"},{status:413});return Response.json({message:"تم تفعيل الترخيص بنجاح",license:await installLicense(bytes)})}catch(error){return Response.json({error:error instanceof LicenseError?error.message:"تعذر تثبيت ملف الترخيص",code:error instanceof LicenseError?error.code:undefined},{status:error instanceof LicenseError?error.status:500})}
}
