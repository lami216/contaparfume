import ContaApp from "./conta-app";

export const dynamic = "force-dynamic";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getPrincipalFromRequest, SESSION_COOKIE } from "../lib/auth";
import { getLicenseStatus } from "../lib/license";
import { getDatabase } from "../lib/sqlite";

export default async function Home() {
  const licensed=(await getLicenseStatus()).valid;
  const hasUsers=await getDatabase().collection("users").countDocuments()>0;
  const token=(await cookies()).get(SESSION_COOKIE)?.value;
  const principal=token?await getPrincipalFromRequest(new Request("http://localhost",{headers:{cookie:`${SESSION_COOKIE}=${token}`}})):null;
  if (licensed&&hasUsers&&!principal) redirect("/login");
  return <ContaApp />;
}
