import test from "node:test";
import assert from "node:assert/strict";
import {formatLicenseDuration} from "../app/license-countdown.ts";
test("duration display omits meaningless leading zero units",()=>{assert.equal(formatLicenseDuration(604800),"1 أسبوع");assert.equal(formatLicenseDuration(6*86400+3*3600+12*60+9),"6 يوم • 3 ساعة • 12 دقيقة • 9 ثانية");assert.equal(formatLicenseDuration(1800),"30 دقيقة");assert.equal(formatLicenseDuration(42),"42 ثانية")});
