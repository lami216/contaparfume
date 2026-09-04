import { requireValidLicense } from "../../../../lib/license.ts";
import { requireCapability, validSameOrigin } from "../../../../lib/auth";
import { getDatabase } from "../../../../lib/sqlite";
import { saveInvoiceBranding } from "../../../../lib/invoice-branding";
export async function PUT(request:Request){const licenseDenied=await requireValidLicense();if(licenseDenied)return licenseDenied;const denied=await requireCapability(request,"settings.branding.manage");if(denied)return denied;if(!validSameOrigin(request))return Response.json({error:"طلب غير صالح"},{status:403});try{return Response.json({branding:await saveInvoiceBranding(await getDatabase(),await request.json())})}catch(error){return Response.json({error:error instanceof Error?error.message:"تعذر حفظ الهوية"},{status:400})}}
