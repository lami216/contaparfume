import test from "node:test";
import assert from "node:assert/strict";
import {validateInvoiceBranding} from "../lib/invoice-branding.ts";
const base={storeName:"الكرنه",storePhone:"49823328 / 46991122",storeAddress:"",registrationNumber:"",taxNumber:"",footerNote:"",nameFont:"tahoma",nameFontSize:24,nameFontWeight:800};
test("legacy invoice branding gets an empty logo and keeps multiple phone numbers",()=>{const value=validateInvoiceBranding(base);assert.equal(value.storeLogoDataUrl,"");assert.equal(value.storePhone,base.storePhone)});
test("invoice branding accepts compact raster logos and rejects SVG data URLs",()=>{const logo="data:image/png;base64,AA==";assert.equal(validateInvoiceBranding({...base,storeLogoDataUrl:logo}).storeLogoDataUrl,logo);assert.throws(()=>validateInvoiceBranding({...base,storeLogoDataUrl:"data:image/svg+xml;base64,AA=="}),/صورة الشعار غير صالحة/)});
