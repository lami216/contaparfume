import { getPrincipalFromRequest } from "../../../../lib/auth.ts";
import { getDeviceId, LicenseError } from "../../../../lib/license.ts";
export const runtime="nodejs";
export async function GET(request:Request){if(!await getPrincipalFromRequest(request))return Response.json({error:"غير مصرح"},{status:401});try{return Response.json({deviceId:await getDeviceId()},{headers:{"cache-control":"no-store"}})}catch(error){return Response.json({error:error instanceof Error?error.message:"تعذر استخراج رقم الجهاز. تواصل مع الدعم."},{status:error instanceof LicenseError?error.status:500})}}
