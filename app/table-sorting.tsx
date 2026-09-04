"use client";
import { useMemo, useState, type ReactNode } from "react";

export type TableValueType="text"|"number"|"money"|"date";
export type TableSort={key:string;direction:"asc"|"desc"}|null;
export type SortColumn<T>={key:string;type:TableValueType;get:(row:T)=>unknown};
const empty=(value:unknown)=>value===null||value===undefined||value==="";

export function compareTableValues(left:unknown,right:unknown,type:TableValueType,direction:"asc"|"desc"){
  if(empty(left)||empty(right)){if(empty(left)&&empty(right))return 0;return empty(left)?1:-1}
  let result=0;
  if(type==="text")result=String(left).localeCompare(String(right),undefined,{numeric:true,sensitivity:"base"});
  else if(type==="date")result=new Date(String(left)).getTime()-new Date(String(right)).getTime();
  else result=Number(left)-Number(right);
  return result*(direction==="asc"?1:-1);
}

export function sortTableRows<T>(rows:readonly T[],sort:TableSort,columns:readonly SortColumn<T>[]){
  if(!sort)return [...rows];const column=columns.find(item=>item.key===sort.key);if(!column)return [...rows];
  return rows.map((row,index)=>({row,index})).sort((a,b)=>compareTableValues(column.get(a.row),column.get(b.row),column.type,sort.direction)||a.index-b.index).map(item=>item.row);
}

export function useSortableRows<T>(rows:readonly T[],columns:readonly SortColumn<T>[]){
  const [sort,setSort]=useState<TableSort>(null),sortedRows=useMemo(()=>sortTableRows(rows,sort,columns),[rows,sort,columns]);
  const toggle=(key:string)=>{const column=columns.find(item=>item.key===key);if(!column)return;const initial=column.type==="text"?"asc":"desc";setSort(current=>({key,direction:current?.key===key?(current.direction==="asc"?"desc":"asc"):initial}))};
  return {sort,sortedRows,toggle};
}

export function SortableTableHeader({column,label,sort,toggle}:{column:string;label:ReactNode;sort:TableSort;toggle:(key:string)=>void}){
  const active=sort?.key===column;return <th aria-sort={active?(sort.direction==="asc"?"ascending":"descending"):"none"}><button type="button" className="report-sort-header" onClick={()=>toggle(column)}>{label}{active&&(sort.direction==="asc"?" ↑":" ↓")}</button></th>;
}
