import { requireValidLicense } from "../../../../../lib/license.ts";
import { requireCapability, validSameOrigin } from "../../../../../lib/auth.ts";
import { MAX_LEGACY_BYTES } from "../../../../../legacy/dataacc-sqlite.ts";
export const runtime="nodejs";
export async function POST(request:Request){const licenseDenied=await requireValidLicense();if(licenseDenied)return licenseDenied;const denied=await requireCapability(request,"settings.legacy.import");if(denied)return denied;if(!validSameOrigin(request))return Response.json({error:"طلب غير صالح"},{status:403});if(Number(request.headers.get("content-length")??0)>MAX_LEGACY_BYTES)return Response.json({error:"الملف أكبر من الحد المسموح"},{status:413});return Response.json({error:"استخدم مسار الرفع المرحلي لمتابعة تقدم الاستيراد"},{status:410});}
