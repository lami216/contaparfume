import { createSession, normalizeUsername, SESSION_COOKIE, sessionCookieOptions, validSameOrigin, verifyPasswordHash } from "../../../../lib/auth";
import { getDatabase } from "../../../../lib/sqlite";

export async function POST(request: Request) {
  if (!validSameOrigin(request)) return Response.json({ error: "طلب غير صالح" }, { status: 403 });
  const clientLogin = request.headers.get("x-alkarna-login-ui") === "1";
  const data = await request.formData();
  const password = data.get("password"), username = data.get("username");
  if (typeof password !== "string" || typeof username !== "string") return clientLogin ? Response.json({ok:false,field:"username",error:"اسم المستخدم غير صحيح"},{status:401}) : Response.redirect(new URL("/login?error=1", request.url),303);
  const normalized=normalizeUsername(username);
  const user=await (await getDatabase()).collection("users").findOne({usernameNormalized:normalized,isActive:true});
  if(!user) return clientLogin ? Response.json({ok:false,field:"username",error:"اسم المستخدم غير صحيح"},{status:401}) : Response.redirect(new URL("/login?error=1",request.url),303);
  if(!verifyPasswordHash(password,String(user.passwordHash??""))) return clientLogin ? Response.json({ok:false,field:"password",error:"كلمة المرور غير صحيحة"},{status:401}) : Response.redirect(new URL("/login?error=1",request.url),303);
  const principal=user.owner===true?{principalType:"owner" as const}:{principalType:"user" as const,userId:String(user.id)};
  const cookie=`${SESSION_COOKIE}=${createSession(principal)}; ${sessionCookieOptions}`;
  if(clientLogin)return Response.json({ok:true},{headers:{"Set-Cookie":cookie}});
  return new Response(null,{status:303,headers:{Location:"/","Set-Cookie":cookie}});
}
