import type { DocumentRecord } from "./domain";

type PartyPayment = Pick<DocumentRecord, "kind" | "status" | "partyCashDirection">;

/** The history remains readable after cancellation, but its cash posting is final. */
export function canManagePartyPayment<T extends PartyPayment>(
  document: T | null | undefined,
  permitted: boolean,
): document is T & { partyCashDirection: "receive" | "pay" } {
  return permitted && document?.kind === "payment" && document.status === "posted" &&
    (document.partyCashDirection === "receive" || document.partyCashDirection === "pay");
}
