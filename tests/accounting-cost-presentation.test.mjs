import assert from 'node:assert/strict';
import test from 'node:test';
import {reportHasUnknownCost,reportCostUnknown,reportCostExportValue} from '../app/report-cost-status.ts';
import {buildReportFooterMetrics} from '../app/report-footer.ts';
import {suggestedPurchasePrice,purchaseLineFor} from '../app/purchase-draft.ts';

test('new purchase lines use the same latest-price suggestion as search while retaining deliberate card fallback',()=>{
 for(const [lastPurchaseCost,pieceCost,expected]of [[100,0,100],[100,50,100],[null,50,50],[0,50,0],[undefined,null,0]]){const p={id:'p',name:'P',piecePrice:150,lastPurchaseCost,pieceCost};assert.equal(suggestedPurchasePrice(p),expected);assert.equal(Number(purchaseLineFor(p).unitPrice),expected);}
});
test('missing-cost flags mask every dependent financial conclusion, while explicit known zero remains numeric',()=>{
 for(const state of [{unknownRevenue:150},{costKnown:false,unknownRevenue:0}]){assert.equal(reportHasUnknownCost(state),true);for(const key of ['cost','profit','margin','salesCost','salesProfit','netOperatingResult','netProfitAfterInventoryLoss']){assert.equal(reportCostUnknown(key,state),true);assert.equal(reportCostExportValue(key,150,state,'غير مؤكد'),'غير مؤكد');}for(const key of ['revenue','sales','netSales','expenses','purchases','paid','due'])assert.equal(reportCostUnknown(key,state),false);}
 const known={costKnown:true,unknownRevenue:0};assert.equal(reportCostUnknown('profit',known),false);assert.equal(reportCostExportValue('cost',0,known,'غير مؤكد'),0);assert.equal(reportCostExportValue('profit',150,known,'غير مؤكد'),150);
});
test('footer marks only cost-dependent metrics as uncertain for screen, print and export consumers',()=>{
 for(const type of ['sales','profit','product-sales']){const result={report:type,summary:{netSales:150,sales:150,revenue:150,cost:0,profit:150,margin:100,unknownRevenue:150},rows:[],meta:{page:1,pageSize:100,totalRows:0,totalPages:1},from:null,to:null};const metrics=buildReportFooterMetrics({type,result});for(const m of metrics){const sensitive=['cost','profit','margin','netProfitAfterInventoryLoss'].includes(m.key);assert.equal(Boolean(m.uncertain),sensitive);}}
 const result={report:'sales',summary:{netSales:150,cost:0,profit:150,margin:100,unknownRevenue:0,costKnown:true},rows:[],meta:{page:1,pageSize:100,totalRows:0,totalPages:1},from:null,to:null};assert.ok(buildReportFooterMetrics({type:'sales',result}).every(m=>!m.uncertain));
});
