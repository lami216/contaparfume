import { getDatabase } from "../../../lib/sqlite";
import { log } from "../../../lib/log";

export async function GET() {
  try {
    const db = await getDatabase();
    await db.command({ ping: 1 });
    return Response.json({ status: "ok", database: "connected" });
  } catch (error) {
    log("error", "health.failed", { error });
    return Response.json({ status: "error", database: "unavailable" }, { status: 503 });
  }
}
