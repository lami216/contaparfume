import assert from 'node:assert/strict';
import test from 'node:test';
import {accountingMoney,accountingNumber,accountingPercent,formatMoney,formatNumber,formatQuantity,money,number,quantity} from '../app/domain.ts';
import {formatAccountingMoney,formatAccountingNumber,formatAccountingPercent,formatMoney as localizedMoney} from '../app/i18n/formatting.ts';
import {accountingExcelNumberFormat,formatAccountingDecimal,formatAccountingPercentage} from '../lib/accounting-format.ts';
import {createXlsx} from '../app/xlsx-export.ts';
import {setDisplayCurrencyCode} from '../lib/currency-core.ts';

test('ordinary monetary formatting and unrelated number/quantity formatting stay compatible',()=>{
  for(const value of [0,7,8.6,100,1211,17700,1.234567,-1.234567]){
    assert.equal(accountingNumber(value),formatNumber(value));
    assert.equal(accountingMoney(value),formatMoney(value));
    assert.equal(money(value),formatMoney(value));
    assert.equal(number(value),formatNumber(value));
    assert.equal(quantity(value),formatQuantity(value));
  }
  assert.equal(formatMoney(0.0001),'0 MRU'); // Legacy function is intentionally compatible.
  assert.equal(number(0.0001),'0');
  assert.equal(quantity(0.0001),'0');
  assert.equal(money(0.0001),'0,0001 MRU');
});

test('finite nonzero positive and negative amounts never become a displayed zero',()=>{
  for(const value of [0.0001,-0.0001,1e-12,-1e-12,1e-15,-1e-15,Number.MIN_VALUE,-Number.MIN_VALUE]){
    const text=accountingNumber(value);
    assert.notEqual(text,'0');assert.notEqual(text,'-0');
    assert.match(text,/[1-9]/);
    assert.equal(text.startsWith('-'),value<0);
  }
  assert.equal(accountingNumber(-0),'0');
  assert.equal(accountingMoney(-0),'0 MRU');
  assert.equal(accountingNumber(0),'0');
  assert.match(accountingNumber(1e-15),/E-15$/);
});

test('percentage precision does not falsely claim a full margin on either side of plus or minus100',()=>{
  for(const value of [99.9996,100.0001,-99.9996,-100.0001]){
    assert.notEqual(accountingPercent(value),`${value<0?'-':''}100%`);
  }
  assert.equal(accountingPercent(99.9996),'99,9996%');
  assert.equal(accountingPercent(99.99999999999999),'<100%');
  assert.equal(accountingPercent(100.00000000000001),'>100%');
  assert.equal(accountingPercent(-99.99999999999999),'>-100%');
  assert.equal(accountingPercent(-100.00000000000001),'<-100%');
  assert.equal(accountingPercent(100),'100%');
  assert.equal(accountingPercent(-100),'-100%');
  assert.equal(accountingPercent(0),'0%');
  assert.equal(accountingPercent(-0),'0%');
  assert.equal(accountingPercent(100/3),'33,333%');
  assert.equal(accountingPercent(0.0001),'0,0001%');
});

test('Arabic and French opt-in formatters retain normal locale and active currency',()=>{
  try{
    setDisplayCurrencyCode('EUR');
    for(const locale of ['ar','fr']){
      assert.equal(formatAccountingMoney(locale,1250),localizedMoney(locale,1250));
      assert.match(formatAccountingMoney(locale,0.0001),/[1-9].* EUR$/);
      assert.doesNotMatch(formatAccountingMoney(locale,0.0001),/[٠-٩۰-۹]/);
      assert.notEqual(formatAccountingNumber(locale,-0.0001),formatAccountingNumber(locale,-0));
      assert.notEqual(formatAccountingPercent(locale,99.9996),'100%');
      assert.equal(formatAccountingPercent(locale,100),'100%');
    }
    assert.equal(accountingMoney(0.0001),'0,0001 EUR');
  }finally{setDisplayCurrencyCode('MRU');}
});

test('precision helpers preserve caller fraction policy and avoid inventing unknown numbers',()=>{
  assert.equal(formatAccountingDecimal('fr-FR',12.345,{maximumFractionDigits:2}),'12,35');
  assert.equal(formatAccountingDecimal('fr-FR',0.0001,{maximumFractionDigits:2}),'0,0001');
  assert.equal(formatAccountingPercentage('fr-FR',99.9996,{maximumFractionDigits:2}),'99,9996%');
  assert.equal(formatAccountingDecimal('fr-FR',Number.POSITIVE_INFINITY),'∞');
  assert.equal(formatAccountingDecimal('fr-FR',Number.NaN),'NaN');
});

function zipParts(bytes){
  const buffer=Buffer.from(bytes),parts=new Map();let offset=0;
  while(buffer.readUInt32LE(offset)===0x04034b50){
    const size=buffer.readUInt32LE(offset+18),nameLength=buffer.readUInt16LE(offset+26),extraLength=buffer.readUInt16LE(offset+28);
    const start=offset+30,name=buffer.subarray(start,start+nameLength).toString('utf8'),content=start+nameLength+extraLength;
    parts.set(name,buffer.subarray(content,content+size).toString('utf8'));offset=content+size;
  }
  return parts;
}

test('Excel monetary and percentage styles retain exact numeric XML and leave unmarked quantities alone',()=>{
  const rows=[['Cost','Margin','Quantity'],[0.0001,99.9996,0.0001],[-1e-15,-99.99999999999999,3],[0,100,4]];
  const original=structuredClone(rows);
  const parts=zipParts(createXlsx([{name:'Accounting',rows,cellFormats:[[],['number','percent'],['number','percent'],['number','percent']]}]));
  const sheet=parts.get('xl/worksheets/sheet1.xml'),styles=parts.get('xl/styles.xml');
  assert.deepEqual(rows,original);
  assert.match(sheet,/<c r="A2" s="\d+"><v>0\.0001<\/v><\/c>/);
  assert.match(sheet,/<c r="B2" s="\d+"><v>99\.9996<\/v><\/c>/);
  assert.match(sheet,/<c r="A3" s="\d+"><v>-1e-15<\/v><\/c>/);
  assert.match(sheet,/<c r="B3" s="\d+"><v>-99\.99999999999999<\/v><\/c>/);
  assert.match(sheet,/<c r="C2"><v>0\.0001<\/v><\/c>/);
  assert.match(styles,/formatCode="#,##0\.####"/);
  assert.match(styles,/formatCode="#,##0\.####&quot;%&quot;"/);
  assert.match(styles,/formatCode="0\.##############E\+00"/);
  assert.match(styles,/&quot;&gt;-100%&quot;;&quot;&gt;-100%&quot;;&quot;&gt;-100%&quot;/);
  assert.match(styles,/applyNumberFormat="1"/);
  assert.doesNotMatch(sheet,/<c r="[AB][234]"[^>]*t="inlineStr"/);
});

test('Excel exact zero and full percentages remain numeric and unformatted workbooks keep default styles',()=>{
  assert.equal(accountingExcelNumberFormat(0,'number'),'#,##0.###');
  assert.equal(accountingExcelNumberFormat(100,'percent'),'#,##0.###"%"');
  assert.equal(accountingExcelNumberFormat(-100,'percent'),'#,##0.###"%"');
  const parts=zipParts(createXlsx([{name:'Old export',rows:[['Value'],[0.0001],[99.9996]]}]));
  assert.match(parts.get('xl/styles.xml'),/<cellXfs count="2">/);
  assert.doesNotMatch(parts.get('xl/styles.xml'),/<numFmts/);
  assert.match(parts.get('xl/worksheets/sheet1.xml'),/<c r="A2"><v>0\.0001<\/v><\/c>/);
});
