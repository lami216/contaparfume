"use client";
import { useMemo, useState, type ReactNode } from "react";

export type TableValueType="text"|"number"|"money"|"date";
export type TableSort={key:string;direction:"asc"|"desc"}|null;
export type SortColumn<T>={key:string;type:TableValueType;get:(row:T)=>unknown};
const empty=(value:unknown)=>value===null||value===undefined||(typeof value==="string"&&value.trim()==="");
const naturalCompare=(left:unknown,right:unknown,locale?:string)=>String(left).localeCompare(String(right),locale,{numeric:true,sensitivity:"base"});
const finiteNumber=(value:unknown)=>{try{const numeric=typeof value==="number"?value:Number(typeof value==="string"?value.trim():value);return Number.isFinite(numeric)?numeric:null}catch{return null}};

export function compareTableValues(left:unknown,right:unknown,type:TableValueType,direction:"asc"|"desc",locale?:string){
  const leftEmpty=empty(left),rightEmpty=empty(right);
  if(leftEmpty||rightEmpty){if(leftEmpty&&rightEmpty)return 0;return leftEmpty?1:-1}
  let result=0;
  if(type==="text")result=naturalCompare(left,right,locale);
  else if(type==="date"){
    const leftTime=new Date(String(left)).getTime(),rightTime=new Date(String(right)).getTime();
    result=Number.isFinite(leftTime)&&Number.isFinite(rightTime)?leftTime-rightTime:naturalCompare(left,right,locale);
  } else {
    const leftNumber=finiteNumber(left),rightNumber=finiteNumber(right);
    result=leftNumber!==null&&rightNumber!==null?leftNumber-rightNumber:naturalCompare(left,right,locale);
  }
  return result*(direction==="asc"?1:-1);
}

export function sortTableRows<T>(rows:readonly T[],sort:TableSort,columns:readonly SortColumn<T>[],locale?:string){
  if(!sort)return [...rows];const column=columns.find(item=>item.key===sort.key);if(!column)return [...rows];
  return rows.map((row,index)=>({row,index})).sort((a,b)=>compareTableValues(column.get(a.row),column.get(b.row),column.type,sort.direction,locale)||a.index-b.index).map(item=>item.row);
}

export function useSortableRows<T>(rows:readonly T[],columns:readonly SortColumn<T>[],locale?:string){
  const [sort,setSort]=useState<TableSort>(null),sortedRows=useMemo(()=>sortTableRows(rows,sort,columns,locale),[rows,sort,columns,locale]);
  const toggle=(key:string)=>{const column=columns.find(item=>item.key===key);if(!column)return;const initial=column.type==="text"?"asc":"desc";setSort(current=>({key,direction:current?.key===key?(current.direction==="asc"?"desc":"asc"):initial}))};
  return {sort,sortedRows,toggle};
}

export function SortableTableHeader({column,label,sort,toggle}:{column:string;label:ReactNode;sort:TableSort;toggle:(key:string)=>void}){
  const active=sort?.key===column;return <th aria-sort={active?(sort.direction==="asc"?"ascending":"descending"):"none"}><button type="button" className="report-sort-header" onClick={()=>toggle(column)}>{label}{active&&(sort.direction==="asc"?" ↑":" ↓")}</button></th>;
}
