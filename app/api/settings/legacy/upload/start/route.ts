import { requireValidLicense } from "../../../../../../lib/license.ts";
import { requireCapability, validSameOrigin } from "../../../../../../lib/auth.ts";
import { startLegacyUpload } from "../../../../../../legacy/upload-store.ts";
export const runtime = "nodejs";
export async function POST(request: Request) {const licenseDenied=await requireValidLicense();if(licenseDenied)return licenseDenied; const denied=await requireCapability(request,"settings.legacy.import");if(denied)return denied;if(!validSameOrigin(request))return Response.json({error:"طلب غير صالح"},{status:403});try{const {size}=await request.json() as {size:number};return Response.json(await startLegacyUpload(size));}catch(e){return Response.json({error:e instanceof Error?e.message:"تعذر بدء الرفع"},{status:400});} }
