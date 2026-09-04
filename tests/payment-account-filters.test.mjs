import assert from "node:assert/strict";
import test from "node:test";
import { activePaymentAccounts } from "../app/domain.ts";
test("active payment-account selector excludes both inactive and archived accounts",()=>assert.deepEqual(activePaymentAccounts([{id:"active",isActive:true},{id:"inactive",isActive:false},{id:"archived",isActive:true,isArchived:true}]).map(x=>x.id),["active"]));
