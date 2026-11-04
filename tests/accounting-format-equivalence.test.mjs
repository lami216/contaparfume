import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {formatAccountingDecimal,formatAccountingPercentage,accountingExcelNumberFormat} from '../lib/accounting-format.ts';

const golden=JSON.parse(readFileSync(new URL('./fixtures/accounting-precision-golden.json',import.meta.url),'utf8'));
const number=tag=>tag==='MAX'?Number.MAX_VALUE:tag==='-MAX'?-Number.MAX_VALUE:tag==='MIN'?Number.MIN_VALUE:tag==='-MIN'?-Number.MIN_VALUE:Number(tag);

test('optimized financial formatting exactly preserves the prior precision outputs across locales and IEEE boundaries',()=>{
  assert.equal(golden.cases.length,792);
  for(const row of golden.cases){
    const value=number(row.value),context=`${row.locale} ${row.value} ${JSON.stringify(row.options)}`;
    assert.equal(formatAccountingDecimal(row.locale,value,row.options),row.decimal,context+' decimal');
    assert.equal(formatAccountingPercentage(row.locale,value,row.options),row.percent,context+' percent');
  }
});

test('Excel financial number formats remain byte-for-byte compatible with the prior precision policy',()=>{
  for(const row of golden.excel){
    assert.equal(accountingExcelNumberFormat(number(row.value),'number'),row.number,row.value+' number');
    assert.equal(accountingExcelNumberFormat(number(row.value),'percent'),row.percent,row.value+' percent');
  }
});

test('warm monetary renders do not repeat Intl configuration or format-to-parts work per cell',t=>{
  const locale='fr-FR-u-nu-latn';
  formatAccountingDecimal(locale,100);
  formatAccountingPercentage(locale,99.9996);
  const originalResolved=Intl.NumberFormat.prototype.resolvedOptions,originalParts=Intl.NumberFormat.prototype.formatToParts;
  let resolved=0,parts=0;
  Intl.NumberFormat.prototype.resolvedOptions=function(...args){resolved++;return originalResolved.apply(this,args)};
  Intl.NumberFormat.prototype.formatToParts=function(...args){parts++;return originalParts.apply(this,args)};
  t.after(()=>{Intl.NumberFormat.prototype.resolvedOptions=originalResolved;Intl.NumberFormat.prototype.formatToParts=originalParts});
  for(let index=0;index<1000;index++){
    assert.equal(formatAccountingDecimal(locale,100),'100');
    assert.equal(formatAccountingPercentage(locale,99.9996),'99,9996%');
  }
  assert.equal(resolved,0,'Locale rounding configuration must be cached, rather than inspected per cell');
  assert.equal(parts,0,'Full part arrays are unnecessary for every ordinary monetary cell');
});
