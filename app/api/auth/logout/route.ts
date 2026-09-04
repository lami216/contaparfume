import { SESSION_COOKIE, validSameOrigin } from "../../../../lib/auth";
export async function POST(request: Request) {
  if (!validSameOrigin(request)) return Response.json({ error: "طلب غير صالح" }, { status: 403 });
  return new Response(null, { status: 303, headers: { Location: "/login", "Set-Cookie": `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${process.env.NODE_ENV === "production" ? "; Secure" : ""}` } });
}
