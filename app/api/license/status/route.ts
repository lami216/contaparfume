import { getPrincipalFromRequest } from "../../../../lib/auth.ts";
import { getLicenseStatus } from "../../../../lib/license.ts";
export const runtime="nodejs";
export async function GET(request:Request){if(!await getPrincipalFromRequest(request))return Response.json({error:"غير مصرح"},{status:401});return Response.json(await getLicenseStatus(),{headers:{"cache-control":"no-store"}})}
