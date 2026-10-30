/** Quantity provenance is replayed from immutable movements, never inferred from
 * today's balance or the final status of a document. No stored data is rewritten. */
type Source = { kind: "opening" | "other"; key: string; quantity: number };
type Withdrawal = { parts: Source[] };
const EPSILON = 1e-9;

export class StockProvenance {
  private stocks = new Map<string, Source[]>();
  private seenWarehouses = new Set<string>();
  private operations = new Map<string, Withdrawal[]>();
  private movements = new Map<string, Withdrawal>();
  private substitutions = new Map<string, Source[]>();

  seedWarehouse(warehouseId: string, balanceBefore: number | null) {
    if (this.seenWarehouses.has(warehouseId)) return;
    this.seenWarehouses.add(warehouseId);
    // Incomplete/legacy history can prove a pre-existing non-opening balance,
    // but cannot establish any new native opening entitlement.
    if (balanceBefore !== null && balanceBefore > 0 && !this.stocks.has(warehouseId))
      this.deposit(warehouseId, [{ kind: "other", key: "unattributed", quantity: balanceBefore }]);
  }

  deposit(warehouseId: string, parts: Source[]) {
    const stock = this.stocks.get(warehouseId) ?? [];
    for (const part of parts) if (part.quantity > EPSILON) stock.push({ ...part });
    this.stocks.set(warehouseId, stock);
  }

  add(warehouseId: string, quantity: number, kind: Source["kind"], key: string) {
    this.deposit(warehouseId, [{ kind, key, quantity }]);
  }

  quantity(warehouseId: string) {
    return (this.stocks.get(warehouseId) ?? []).reduce((sum, part) => sum + part.quantity, 0);
  }

  private resolveReturned(parts: Source[], visiting = new Set<string>()): Source[] {
    const resolved: Source[] = [];
    for (const part of parts) {
      let remaining = part.quantity;
      const substitutes = part.kind === "other" && !visiting.has(part.key) ? this.substitutions.get(part.key) : undefined;
      for (const substitute of substitutes ?? []) {
        if (remaining <= EPSILON) break;
        const quantity = Math.min(remaining, substitute.quantity);
        if (quantity <= EPSILON) continue;
        substitute.quantity -= quantity; remaining -= quantity;
        resolved.push(...this.resolveReturned([{ ...substitute, quantity }], new Set([...visiting, part.key])));
      }
      if (remaining > EPSILON) resolved.push({ ...part, quantity: remaining });
    }
    return resolved;
  }

  reverseInflow(warehouseId: string, quantity: number, sourceKey: string) {
    const own = this.takeMatching(warehouseId, quantity, part => part.kind === "other" && part.key === sourceKey);
    if (own.remaining <= EPSILON) return;
    // A purchase may be canceled using replacement stock after its actual units
    // were consumed or transferred. Remember exactly which source was displaced.
    const displaced = this.withdraw(warehouseId, own.remaining, undefined, true);
    this.substitutions.set(sourceKey, [...(this.substitutions.get(sourceKey) ?? []), ...displaced]);
    // The source can still exist in another warehouse. Reclassify its entitlement
    // there now; otherwise refund it when its recorded withdrawal is reversed.
    for (const [wh, stock] of this.stocks)
      this.stocks.set(wh, stock.flatMap(part => part.key === sourceKey ? this.resolveReturned([part]) : [part]));
  }

  private takeMatching(warehouseId: string, quantity: number, predicate: (part: Source) => boolean) {
    const stock = this.stocks.get(warehouseId) ?? [], parts: Source[] = [];
    let remaining = Math.max(0, quantity);
    for (const part of stock) {
      if (remaining <= EPSILON) break;
      if (!predicate(part) || part.quantity <= EPSILON) continue;
      const taken = Math.min(remaining, part.quantity);
      parts.push({ ...part, quantity: taken }); part.quantity -= taken; remaining -= taken;
    }
    this.stocks.set(warehouseId, stock.filter(part => part.quantity > EPSILON));
    return { parts, remaining };
  }

  removeOpening(warehouseId: string, quantity: number) {
    const result = this.takeMatching(warehouseId, quantity, part => part.kind === "opening");
    return quantity - result.remaining;
  }

  withdraw(warehouseId: string, quantity: number, ownSource?: string, otherFirst = false) {
    const parts: Source[] = [];
    let remaining = Math.max(0, quantity);
    const take = (predicate: (part: Source) => boolean) => {
      const result = this.takeMatching(warehouseId, remaining, predicate);
      parts.push(...result.parts); remaining = result.remaining;
    };
    if (ownSource) take(part => part.key === ownSource && part.kind === "other");
    const first = otherFirst ? "other" : "opening", second = otherFirst ? "opening" : "other";
    take(part => part.kind === first); take(part => part.kind === second);
    // A missing historic inflow is not evidence of additional opening stock.
    if (remaining > EPSILON) parts.push({ kind: "other", key: "unattributed", quantity: remaining });
    return parts;
  }

  remember(operationKey: string, movementId: string, parts: Source[]) {
    const withdrawal = { parts: parts.map(part => ({ ...part })) };
    const history = this.operations.get(operationKey) ?? [];
    history.push(withdrawal); this.operations.set(operationKey, history);
    if (movementId) this.movements.set(movementId, withdrawal);
  }

  restore(warehouseId: string, quantity: number, operationKey: string, reversalOfMovementId?: string) {
    const explicit = reversalOfMovementId ? this.movements.get(reversalOfMovementId) : undefined;
    const history = reversalOfMovementId ? (explicit ? [explicit] : []) : this.operations.get(operationKey) ?? [];
    let remaining = Math.max(0, quantity);
    // The same withdrawal objects are shared by both indexes: a linked reversal
    // cannot restore an opening quantity a second time through the legacy path.
    for (let index = history.length - 1; index >= 0 && remaining > EPSILON; index--) {
      const parts = history[index].parts;
      for (let partIndex = parts.length - 1; partIndex >= 0 && remaining > EPSILON; partIndex--) {
        const part = parts[partIndex], restored = Math.min(remaining, part.quantity);
        this.deposit(warehouseId, this.resolveReturned([{ ...part, quantity: restored }]));
        part.quantity -= restored; remaining -= restored;
      }
    }
    return remaining;
  }

  openingAllocations() {
    const allocations: Record<string, number> = {};
    for (const [warehouseId, parts] of this.stocks) {
      const quantity = parts.filter(part => part.kind === "opening").reduce((sum, part) => sum + part.quantity, 0);
      if (quantity > EPSILON) allocations[warehouseId] = quantity;
    }
    return allocations;
  }
}
