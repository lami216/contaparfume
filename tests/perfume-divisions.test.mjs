import assert from "node:assert/strict";
import test from "node:test";
import { divisionLandedCost, roundedDivisionLiquidCost } from "../app/perfume-logic.ts";

test("division liquid cost always rounds upward to the next whole MRU", () => {
  assert.equal(roundedDivisionLiquidCost(10000, 6), 1667);
  assert.equal(roundedDivisionLiquidCost(10000, 10), 1000);
  assert.equal(roundedDivisionLiquidCost(10001, 10), 1001);
});

test("landed decant cost adds bottle cost after upward rounding", () => {
  assert.equal(divisionLandedCost(10000, 6, 100), 1767);
  assert.equal(divisionLandedCost(10000, 10, 125), 1125);
});
