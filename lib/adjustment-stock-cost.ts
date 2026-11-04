import { stockBalanceAfter, stockNumber } from "./stock-numbers.ts";

type Row = Record<string, unknown>;
type Family = "purchase" | "sale" | "opening" | "opening-correction" | "adjustment";
type Phase = "post" | "edit" | "void";
const eventTypes: Readonly<Record<string, readonly [Family, Phase]>> = {
  purchase: ["purchase", "post"],
  "purchase-edit": ["purchase", "edit"],
  "purchase-void": ["purchase", "void"],
  sale: ["sale", "post"],
  "sale-edit": ["sale", "edit"],
  "sale-void": ["sale", "void"],
  opening: ["opening", "post"],
  "opening-void": ["opening", "void"],
  "opening-correction": ["opening-correction", "post"],
  "opening-correction-void": ["opening-correction", "void"],
  adjustment: ["adjustment", "post"],
  "adjustment-edit": ["adjustment", "edit"],
  "adjustment-void": ["adjustment", "void"],
};

export type AdjustmentStockCostEvidence = {
  unitCost: number;
  documentId: string;
  number: string;
  lineId: string;
  movementId: string;
  occurredAt: string;
  kind: "adjustment";
  warehouseId: string;
  revision: number;
  quantity: number;
};

export type AdjustmentStockCostInput = {
  productId: string;
  warehouseId: string;
  /** SQLite insertion order, including all warehouses for the product. */
  movements: readonly Row[];
  /** Include canceled source documents and sources whose SKU was later removed. */
  documents: readonly Row[];
} & ({ currentStock: unknown; debitMovementId?: never } | { debitMovementId: string; currentStock?: never });

type Movement = {
  id: string;
  documentId: string;
  number: string;
  occurredAt: string;
  family: Family;
  phase: Phase;
  revision: number;
  before: number;
  delta: number;
  after: number;
};
type Source = {
  document: Row;
  line: Row | undefined;
  family: Family;
  stableCountSnapshot: boolean;
  simpleVoid: boolean;
};
type Origin = {
  id: string;
  family: Family;
  evidence?: Omit<AdjustmentStockCostEvidence, "quantity">;
};
type Part = { origin: Origin; quantity: number };
type Lots = Map<string, Part>;
type Operation = { effect: number; withdrawn: Lots };
type Substitution = { holderId: string; replacement: Part };
type Replay = {
  lots: Lots;
  operations: Map<string, Operation>;
  origins: Map<string, Origin>;
  substitutions: Map<string, Substitution>;
  sources: Map<string, Source>;
  warehouseId: string;
};

const object = (value: unknown): value is Row => value !== null && typeof value === "object" && !Array.isArray(value);
const identifier = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.trim() === value;
const number = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const revision = (value: unknown): value is number => number(value) && Number.isSafeInteger(value) && value >= 0;
const date = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value));
const imported = (document: Row) => Boolean(document.legacyKey || document.legacy || document.importRunId || document.importedFrom || document.sourceType || document.parentDocumentId);
const sameQuantity = (left: number, right: number) => left === right || stockBalanceAfter(left, -right) === 0;
const isOpening = (family: Family) => family === "opening" || family === "opening-correction";

export function isOrdinaryStockCostProduct(product: Row): boolean {
  return !["decant", "bottle", "partial"].includes(String(product.perfumeForm)) &&
    product.perfumeStockUnit !== "ml" && !product.parentProductId && !product.sourceProductId &&
    !(Array.isArray(product.perfumeLots) && product.perfumeLots.length > 0) && product.decantSizeMl == null;
}

const specializedStock = (row: Row) => row.quantityUnit === "ml" || Boolean(
  row.perfumeStockOperationType || row.perfumeConversionType || row.perfumeSaleMode || row.perfumeLotId ||
  row.decantProductId || row.bottleProductId || row.perfumeAllocations || row.bottleAllocations ||
  row.liquidQuantityMl != null || row.fillMl != null
);

function parseMovement(row: Row): Movement | null {
  if (specializedStock(row) || !identifier(row.type) || !Object.hasOwn(eventTypes, row.type)) return null;
  if (!identifier(row.id) || !identifier(row.documentId) || !identifier(row.documentNumber) || !date(row.occurredAt) || !revision(row.documentRevision)) return null;
  const before = row.balanceBefore, delta = row.quantityDelta, after = row.balanceAfter;
  if (!number(before) || !number(delta) || !number(after) || before < 0 || after < 0 || delta === 0) return null;
  // Pre-845 rows retained the raw floating-point sum. New rows may normalize
  // negligible cancellation residue at zero through the shared stock helper.
  if (before + delta !== after && stockBalanceAfter(before, delta) !== after) return null;
  const [family, phase] = eventTypes[row.type];
  return { id: row.id, documentId: row.documentId, number: row.documentNumber, occurredAt: row.occurredAt, family, phase, revision: row.documentRevision, before, delta, after };
}

function sourceMatchesWarehouse(document: Row, family: Family, warehouseId: string) {
  if (family !== "opening-correction") return document.warehouseId === warehouseId;
  return document.warehouseId === warehouseId || document.destinationWarehouseId === warehouseId;
}

function sourceKindMatches(document: Row, family: Family) {
  if (family === "purchase" || family === "sale") return document.kind === family;
  if (document.kind !== "adjustment" || document.productArchiveStockClearance === true) return false;
  if (family === "opening-correction") return document.openingCorrection === true;
  if (document.openingCorrection === true) return false;
  return family === "opening" ? /^OPEN-(?!COR)/.test(String(document.number)) : String(document.number).startsWith("ADJ-");
}

function validateSource(document: Row, rows: Movement[], productId: string, warehouseId: string): Source | null {
  const first = rows[0], last = rows.at(-1)!;
  const family = first.family, documentRevision = document.revision === undefined ? 0 : document.revision;
  if (imported(document) || specializedStock(document) || !identifier(document.number) || !date(document.occurredAt) || !revision(documentRevision)) return null;
  if (!sourceKindMatches(document, family) || !sourceMatchesWarehouse(document, family, warehouseId)) return null;
  if (document.status !== "posted" && document.status !== "voided") return null;
  if (!Array.isArray(document.lines) || document.lines.some(line => !object(line))) return null;
  const matches = document.lines.filter((line: Row) => line.productId === productId);
  if (matches.length > 1) return null;
  const line = matches[0] as Row | undefined;
  const commerce = family === "purchase" || family === "sale";
  if (!line && (!commerce || documentRevision === 0)) return null;
  if (line && (specializedStock(line) || (line.warehouseId != null && line.warehouseId !== warehouseId))) return null;
  const savedQuantity = line ? stockNumber(line.quantity) : 0;
  if (savedQuantity === null || (line && commerce && savedQuantity <= 0)) return null;
  if (first.phase !== "post" && (!commerce || first.phase !== "edit" || first.revision === 0)) return null;
  if (first.phase === "post" && (first.revision !== 0 || first.occurredAt !== document.occurredAt)) return null;
  if (last.revision > documentRevision) return null;
  if (last.phase === "void" && (document.status !== "voided" || last.revision !== documentRevision)) return null;
  if (document.status === "voided" && line && last.phase !== "void") return null;

  let effect = 0, previousRevision = -1;
  let stableCountSnapshot = family === "adjustment" && first.delta > 0;
  for (const row of rows) {
    if (row.family !== family || row.number !== document.number || row.revision <= previousRevision) return null;
    if (row.phase === "post" && row !== first) return null;
    if (row.phase === "void" && (row !== last || !sameQuantity(row.delta, -effect))) return null;
    effect = stockBalanceAfter(effect, row.delta);
    if (!Number.isFinite(effect)) return null;
    // A count can acquire a new price when it crosses back from a nonpositive
    // effect. The final line cannot prove the price of its earlier epoch.
    if (effect <= 0) stableCountSnapshot = false;
    if ((family === "purchase" || family === "opening") && effect < 0) return null;
    if (family === "sale" && effect > 0) return null;
    previousRevision = row.revision;
  }
  const expected = document.status === "voided" ? 0 : family === "sale" ? -savedQuantity : savedQuantity;
  if (!sameQuantity(effect, expected)) return null;
  if (last.phase === "void" && !sameQuantity(last.delta, family === "sale" ? savedQuantity : -savedQuantity)) return null;

  if (family === "opening") {
    if (savedQuantity <= 0 || first.before !== 0 || !sameQuantity(first.delta, savedQuantity)) return null;
    if (document.openingStockAfter !== undefined && stockNumber(document.openingStockAfter) !== savedQuantity) return null;
  }
  if (family === "opening-correction") {
    const before = stockNumber(document.openingStockBefore), after = stockNumber(document.openingStockAfter);
    if (before === null || after === null || before < 0 || after < 0 || !sameQuantity(after - before, savedQuantity)) return null;
  }
  if (family === "adjustment" && line) {
    const before = stockNumber(line.balanceBefore), after = stockNumber(line.balanceAfter);
    if (before !== first.before || after === null || after < 0 || !sameQuantity(stockBalanceAfter(before, savedQuantity), after)) return null;
  }
  return { document, line, family, stableCountSnapshot, simpleVoid: rows.length === 2 && first.phase === "post" && last.phase === "void" && last.revision === 1 };
}

const total = (lots: Lots) => [...lots.values()].reduce((sum, part) => sum + part.quantity, 0);

function deposit(lots: Lots, parts: Part[]) {
  for (const part of parts) {
    const existing = lots.get(part.origin.id);
    lots.set(part.origin.id, { origin: part.origin, quantity: (existing?.quantity ?? 0) + part.quantity });
  }
}

/** Take a single identifiable source, or all eligible units. A partial debit of
 * multiple sources has no supported allocation rule and cannot prove a cost. */
function withdraw(lots: Lots, quantity: number, eligible: (part: Part) => boolean = () => true): Part[] | null {
  if (quantity === 0) return [];
  const parts = [...lots.values()].filter(eligible);
  const available = parts.reduce((sum, part) => sum + part.quantity, 0);
  if (!parts.length || !Number.isFinite(available)) return null;
  if (sameQuantity(available, quantity)) {
    for (const part of parts) lots.delete(part.origin.id);
    return parts;
  }
  if (quantity > available || parts.length !== 1) return null;
  const part = parts[0], remaining = stockBalanceAfter(part.quantity, -quantity);
  if (remaining <= 0) return null;
  lots.set(part.origin.id, { ...part, quantity: remaining });
  return [{ origin: part.origin, quantity }];
}

function makeCountEvidence(source: Source, movement: Movement, warehouseId: string): Origin["evidence"] {
  const line = source.line;
  const unitCost = stockNumber(line?.unitPrice);
  if (!source.stableCountSnapshot || source.document.status !== "posted" || !line || !identifier(line.id) || unitCost === null || unitCost <= 0) return undefined;
  return { unitCost, documentId: movement.documentId, number: movement.number, lineId: line.id, movementId: movement.id, occurredAt: movement.occurredAt, kind: "adjustment", warehouseId, revision: movement.revision };
}

/** The original purchase units can be replaced only when one exact reversal
 * owns all of them and the whole replacement count lot has the same rate. */
function substituteCanceledPurchase(replay: Replay, row: Movement, source: Source): boolean {
  const { lots, operations, sources, substitutions } = replay;
  if (row.family !== "purchase" || row.phase !== "void" || !source.simpleVoid || lots.has(row.documentId) || lots.size !== 1 || substitutions.has(row.documentId)) return false;
  const replacement = lots.values().next().value;
  const rate = stockNumber(source.line?.unitPrice);
  if (!replacement?.origin.evidence || rate === null || rate <= 0 || replacement.origin.evidence.unitCost !== rate || !sameQuantity(replacement.quantity, -row.delta)) return false;
  const holders = [...operations].filter(([, operation]) => operation.withdrawn.has(row.documentId));
  if (holders.length !== 1) return false;
  const [holderId, operation] = holders[0];
  const holder = sources.get(holderId);
  const part = operation.withdrawn.get(row.documentId);
  if (!holder?.simpleVoid || !part || operation.withdrawn.size !== 1 || !sameQuantity(operation.effect, row.delta) || !sameQuantity(part.quantity, -row.delta)) return false;
  if (holder.family !== "sale" && holder.family !== "adjustment") return false;
  const heldRate = stockNumber(holder.family === "sale" ? holder.line?.costAtSale : holder.line?.unitPrice);
  if (heldRate !== rate) return false;
  lots.delete(replacement.origin.id);
  substitutions.set(row.documentId, { holderId, replacement });
  return true;
}

function depositReturned(replay: Replay, row: Movement, parts: Part[]): boolean {
  for (const part of parts) {
    const substitution = replay.substitutions.get(part.origin.id);
    if (!substitution) {
      deposit(replay.lots, [part]);
      continue;
    }
    if (row.phase !== "void" || row.documentId !== substitution.holderId || !sameQuantity(part.quantity, substitution.replacement.quantity)) return false;
    deposit(replay.lots, [substitution.replacement]);
    replay.substitutions.delete(part.origin.id);
  }
  return true;
}

function applyMovement(replay: Replay, row: Movement, source: Source): boolean {
  const { lots, operations, origins, warehouseId } = replay;
  const operation = operations.get(row.documentId) ?? { effect: 0, withdrawn: new Map() };
  operations.set(row.documentId, operation);
  const own = (part: Part) => part.origin.id === row.documentId;
  const affected = row.family === "opening-correction" ? (part: Part) => isOpening(part.origin.family) : undefined;
  if (row.delta > 0) {
    const returned = Math.min(row.delta, Math.max(0, -operation.effect));
    const restored = withdraw(operation.withdrawn, returned);
    if (!restored || !depositReturned(replay, row, restored)) return false;
    const gained = stockBalanceAfter(row.delta, -returned);
    if (gained > 0) {
      if (row.family === "sale") return false;
      const origin = origins.get(row.documentId) ?? {
        id: row.documentId,
        family: row.family,
        evidence: row.family === "adjustment" ? makeCountEvidence(source, row, warehouseId) : undefined,
      };
      origins.set(row.documentId, origin);
      deposit(lots, [{ origin, quantity: gained }]);
    }
  } else {
    // Cancel/reduce an acquisition only from its own units. The application
    // can post a replacement-stock reversal; that is not proof for valuation.
    const owned = row.family === "purchase" || row.family === "opening"
      ? -row.delta
      : row.family === "sale" ? 0 : Math.min(-row.delta, Math.max(0, operation.effect));
    if (!withdraw(lots, owned, own) && !substituteCanceledPurchase(replay, row, source)) return false;
    const other = stockBalanceAfter(-row.delta, -owned);
    const taken = withdraw(lots, other, affected);
    if (!taken) return false;
    deposit(operation.withdrawn, taken);
  }
  operation.effect = stockBalanceAfter(operation.effect, row.delta);
  return Number.isFinite(operation.effect) && sameQuantity(total(lots), row.after);
}

function countBasis(lots: Lots, quantity: number): AdjustmentStockCostEvidence | null {
  if (lots.size !== 1 || quantity <= 0) return null;
  const part = lots.values().next().value;
  return part?.origin.evidence && sameQuantity(part.quantity, quantity) ? { ...part.origin.evidence, quantity } : null;
}

/** Prove a current count-only stock balance or the balance immediately before
 * a particular recorded sale debit. Only complete, same-warehouse native
 * chains qualify. No inferred allocation, catalog price, or averaging. */
export function resolveAdjustmentStockCost(input: AdjustmentStockCostInput): AdjustmentStockCostEvidence | null {
  const { productId, warehouseId, debitMovementId } = input;
  if (!identifier(productId) || !identifier(warehouseId)) return null;
  const productRows = input.movements.filter(row => row.productId === productId);
  const cell = productRows.filter(row => row.warehouseId === warehouseId);
  const target = debitMovementId === undefined ? -1 : cell.findIndex(row => row.id === debitMovementId);
  if (debitMovementId !== undefined && target === -1) return null;
  const prefix = target === -1 ? cell : cell.slice(0, target + 1);
  if (!prefix.length) return null;
  const sourceIds = new Set(prefix.map(row => row.documentId));
  const documents = new Map<unknown, Row>();
  for (const document of input.documents) {
    if (!sourceIds.has(document.id)) continue;
    if (documents.has(document.id)) return null;
    documents.set(document.id, document);
  }
  const histories = new Map<string, Movement[]>(), movements = new Map<string, Movement>();
  const movementIds = new Map<unknown, number>();
  for (const row of productRows) movementIds.set(row.id, (movementIds.get(row.id) ?? 0) + 1);
  for (const row of productRows) {
    if (!sourceIds.has(row.documentId)) continue;
    if (row.warehouseId !== warehouseId) return null;
    const movement = parseMovement(row);
    if (!movement || movementIds.get(movement.id) !== 1) return null;
    const history = histories.get(movement.documentId) ?? [];
    history.push(movement);
    histories.set(movement.documentId, history);
    movements.set(movement.id, movement);
  }
  const sources = new Map<string, Source>();
  for (const [id, rows] of histories) {
    const document = documents.get(id);
    const source = document ? validateSource(document, rows, productId, warehouseId) : null;
    if (!source) return null;
    sources.set(id, source);
  }

  const lots: Lots = new Map();
  const replay: Replay = { lots, operations: new Map(), origins: new Map(), substitutions: new Map(), sources, warehouseId };
  let previous = 0;
  for (const raw of prefix) {
    const row = movements.get(String(raw.id));
    if (!row || previous !== row.before || !sameQuantity(total(lots), row.before)) return null;
    const source = sources.get(row.documentId);
    if (!source) return null;
    if (row.id === debitMovementId) {
      if (row.family !== "sale" || row.delta >= 0 || source.document.status !== "posted") return null;
      return countBasis(lots, row.before);
    }
    if (!applyMovement(replay, row, source)) return null;
    previous = row.after;
  }
  const current = stockNumber(input.currentStock);
  return current === previous ? countBasis(lots, previous) : null;
}
