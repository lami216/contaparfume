import test from "node:test";
import assert from "node:assert/strict";
import { normalizePartyNet, partyCashDelta, partyNet } from "../app/party-balance.ts";
test("normalizes positive, negative, and zero party nets",()=>{assert.deepEqual(normalizePartyNet(10),{receivable:10,payable:0,net:10});assert.deepEqual(normalizePartyNet(-7),{receivable:0,payable:7,net:-7});assert.deepEqual(normalizePartyNet(0),{receivable:0,payable:0,net:0})});
test("compatibility net uses receivable minus payable",()=>assert.equal(partyNet({receivable:20,payable:3}),17));
test("cash directions cross zero identically for either role",()=>{assert.equal(500+partyCashDelta("receive",600),-100);assert.equal(-500+partyCashDelta("pay",600),100);assert.equal(0+partyCashDelta("pay",1000),1000);assert.equal(0+partyCashDelta("receive",1000),-1000)});
