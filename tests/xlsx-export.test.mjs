import test from "node:test";
import assert from "node:assert/strict";
import { createXlsx } from "../app/xlsx-export.ts";

test("xlsx exporter emits a real OpenXML zip with RTL Arabic workbook content",()=>{
  const bytes=createXlsx([{name:"جرد المخازن",rows:[["المنتج","الكمية","القيمة"],["مياه",12,144],["أرز",4,128]]}]);
  assert.equal(bytes[0],0x50);
  assert.equal(bytes[1],0x4b);
  assert.equal(bytes[2],0x03);
  assert.equal(bytes[3],0x04);
  const raw=Buffer.from(bytes).toString("utf8");
  assert.match(raw,/\[Content_Types\]\.xml/);
  assert.match(raw,/xl\/workbook\.xml/);
  assert.match(raw,/xl\/worksheets\/sheet1\.xml/);
  assert.match(raw,/rightToLeft="1"/);
  assert.match(raw,/جرد المخازن/);
  assert.match(raw,/مياه/);
  assert.match(raw,/<v>144<\/v>/);
  assert.ok(bytes.length>1000);
});
