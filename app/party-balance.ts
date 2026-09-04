/** Party type is a business role; debt direction always comes from this net. */
export function partyNet(party: { receivable?: unknown; payable?: unknown }) {
  const receivable = Number(party.receivable ?? 0);
  const payable = Number(party.payable ?? 0);
  return (Number.isFinite(receivable) ? receivable : 0) - (Number.isFinite(payable) ? payable : 0);
}

export function normalizePartyNet(value: number) {
  if (!Number.isFinite(value)) throw new TypeError("Party net must be finite");
  const net = Object.is(value, -0) ? 0 : value;
  return { receivable: net > 0 ? net : 0, payable: net < 0 ? Math.abs(net) : 0, net };
}

/** receive decreases party net; pay increases it, regardless of party type. */
export function partyCashDelta(direction: "receive" | "pay", amount: number) {
  if (!Number.isFinite(amount) || amount <= 0) throw new TypeError("Amount must be positive and finite");
  return direction === "receive" ? -amount : amount;
}
