import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const source = async path => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("report footer labels follow the selected language", async () => {
  const [footer, ui, messages] = await Promise.all([source("app/report-footer.ts"), source("app/conta-app.tsx"), source("app/i18n/messages.ts")]);
  assert.match(footer, /translate\?: \(label: string\) => string/);
  assert.match(footer, /t\("صافي المبيعات"\)/);
  assert.match(footer, /t\("المقبوضات التشغيلية"\)/);
  assert.match(ui, /translate:tr/);
  assert.match(messages, /"صافي المبيعات": "Ventes nettes"/);
  assert.match(messages, /"تكلفة البضاعة المباعة": "Coût des marchandises vendues"/);
  assert.match(messages, /"المقبوضات التشغيلية": "Encaissements d’exploitation"/);
  assert.match(messages, /"الوضع الحالي": "Situation actuelle"/);
  assert.match(messages, /"أداء الفترة": "Performance sur la période"/);
});
