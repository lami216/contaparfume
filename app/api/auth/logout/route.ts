import { SESSION_COOKIE, sessionCookieOptions, validSameOrigin } from "../../../../lib/auth";
export async function POST(request: Request) {
  if (!validSameOrigin(request)) return Response.json({ error: "طلب غير صالح" }, { status: 403 });
  return new Response(null, { status: 303, headers: { Location: "/login", "Set-Cookie": `${SESSION_COOKIE}=; ${sessionCookieOptions}; Max-Age=0` } });
}
