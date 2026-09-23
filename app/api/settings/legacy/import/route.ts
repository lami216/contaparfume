import { requireValidLicense } from "../../../../../lib/license.ts";
import { requireCapability, validSameOrigin } from "../../../../../lib/auth.ts";
export const runtime="nodejs";
export async function POST(request:Request){const licenseDenied=await requireValidLicense();if(licenseDenied)return licenseDenied;const denied=await requireCapability(request,"settings.legacy.import");if(denied)return denied;if(!validSameOrigin(request))return Response.json({error:"طلب غير صالح"},{status:403});return Response.json({error:"استخدم مسار الرفع المرحلي لمتابعة تقدم الاستيراد"},{status:410});}
