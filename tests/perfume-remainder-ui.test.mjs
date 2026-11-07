import assert from 'node:assert/strict';
import test from 'node:test';
import { remainderSaleBatches, remainderSaleAvailable } from '../app/perfume-remainder-ui.ts';

const batch=(id,stocks,extra={})=>({product:{id:'decant',perfumeForm:'decant',perfumeStockUnit:'ml',stocks},lot:{id,quantityUnit:'ml',remainingQuantity:Object.values(stocks).reduce((a,b)=>a+b,0),stocks,...extra}});
test('remainder choices contain only positive, open ml stock in the selected warehouse',()=>{
  const positive=batch('positive',{shop:12.5}),empty=batch('empty',{shop:0}),elsewhere=batch('elsewhere',{store:15}),settled=batch('settled',{shop:8},{settledAt:'2026-01-01'}),returned=batch('returned',{shop:8},{partialProductId:'partial'}),legacy=batch('legacy',{shop:3},{quantityUnit:undefined});
  const archived=batch('archived',{shop:4});archived.product.isArchived=true;
  assert.deepEqual(remainderSaleBatches([positive,empty,elsewhere,settled,returned,legacy,archived],'shop').map(b=>b.lot.id),['positive']);
  assert.deepEqual(remainderSaleBatches([positive,empty,elsewhere],'store').map(b=>b.lot.id),['elsewhere']);
});
test('editing a sold-out remainder restores only its own quantity and warehouse for the choices',()=>{
  const soldOut=batch('lot',{shop:0,store:3}),editing={kind:'decant-sale',perfumeSaleMode:'remainder',status:'posted',decantProductId:'decant',perfumeLotId:'lot',warehouseId:'shop',remainderQuantityMl:25};
  assert.equal(remainderSaleBatches([soldOut],'shop').length,0);
  assert.equal(remainderSaleAvailable('decant',soldOut.lot,'shop',editing),25);
  assert.equal(remainderSaleAvailable('decant',soldOut.lot,'store',editing),3);
  assert.equal(remainderSaleAvailable('different-product',soldOut.lot,'shop',editing),0);
  assert.equal(remainderSaleBatches([soldOut],'shop',editing).length,1);
  assert.equal(remainderSaleBatches([soldOut],'shop',{...editing,status:'voided'}).length,0);
});
