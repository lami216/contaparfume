import type {Product} from "./domain.ts";

/** Match the search suggestion; a recorded zero is a valid price. */
export const suggestedPurchasePrice=(product:Pick<Product,"lastPurchaseCost"|"pieceCost">)=>product.lastPurchaseCost??product.pieceCost??0;
export function purchaseLineFor(product:Product){
  return{productId:product.id,quantity:"1",piecePrice:String(product.piecePrice??0),unitPrice:String(suggestedPurchasePrice(product)),actualQuantity:""};
}
