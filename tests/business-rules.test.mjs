import assert from "node:assert/strict";
import test from "node:test";
import { quantity, saleLineTotal } from "../app/domain.ts";
import { reportNumber } from "../app/report-types.ts";

test("sales use quantity multiplied by piece price only", () => {
  assert.equal(saleLineTotal(27, 100), 2700);
  assert.equal(saleLineTotal(13, 100), 1300);
});
test("quantity is displayed without a redundant unit suffix", () => assert.equal(quantity(177), "177"));
test("invalid sale quantities total zero", () => assert.equal(saleLineTotal(-1, 100), 0));
test("missing and non-finite report numbers display as zero", () => {
  assert.deepEqual([reportNumber(null), reportNumber(undefined), reportNumber(Number.NaN), reportNumber(0)], [0, 0, 0, 0]);
});
