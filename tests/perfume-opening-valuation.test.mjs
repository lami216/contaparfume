import test from 'node:test';
import assert from 'node:assert/strict';
import {openingLiquidValue,resolveOpeningBottleCost} from '../app/perfume-opening-valuation.ts';

test('opening valuation prefers the normalized authoritative cost independent of whole-bottle stock',()=>{
 for(const stocks of [{},{w:0},{w:2}])for(const source of ['purchase','opening','legacy-opening'])assert.deepEqual(resolveOpeningBottleCost({pieceCost:9999,lastPurchaseCostSource:source,stocks},1200),{cost:1200,source});
 assert.deepEqual(resolveOpeningBottleCost({pieceCost:1000},'1200'),{cost:1200,source:'authoritative'});
});

test('only the new opening may use a positive saved card reference when current cost is unknown',()=>{
 for(const current of [null,undefined,0,-1,NaN,Infinity,'',true,false,[],{},'unknown']){
  const value=resolveOpeningBottleCost({pieceCost:'1000',openingCost:9000,legacyOpeningCost:8000,lastPurchaseCostSource:'purchase'},current);
  assert.deepEqual(value,{cost:1000,source:'card-reference'});assert.equal(openingLiquidValue(value.cost,40,100).remainingValue,400);
 }
});

test('malformed, missing and nonpositive reference prices never create a guessed opening value',()=>{
 for(const price of [undefined,null,0,-1,NaN,Infinity,'',true,false,[],{},'unknown'])assert.deepEqual(resolveOpeningBottleCost({pieceCost:price},null),{cost:null,source:null});
 assert.throws(()=>openingLiquidValue(0,40,100),/تكلفة شراء/);
});
