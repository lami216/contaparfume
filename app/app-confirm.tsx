"use client";
import { createContext, useCallback, useContext, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "./i18n/provider";

export type AppConfirmOptions={title?:string;message:string;confirmLabel?:string;cancelLabel?:string;tone?:"normal"|"danger"};
type Request={options:AppConfirmOptions;resolve:(accepted:boolean)=>void;opener:HTMLElement|null};
const Context=createContext<((options:AppConfirmOptions)=>Promise<boolean>)|null>(null);

export function ConfirmationProvider({children}:{children:ReactNode}){
  const {t}=useI18n();
  const [request,setRequest]=useState<Request|null>(null), requestRef=useRef<Request|null>(null), dialogRef=useRef<HTMLDivElement>(null), cancelRef=useRef<HTMLButtonElement>(null), confirmRef=useRef<HTMLButtonElement>(null);
  useEffect(()=>{requestRef.current=request},[request]);
  const finish=useCallback((accepted:boolean)=>{const active=requestRef.current;if(!active)return;requestRef.current=null;setRequest(null);active.resolve(accepted);requestAnimationFrame(()=>{if(active.opener?.isConnected)active.opener.focus()})},[]);
  const confirmAction=useCallback((options:AppConfirmOptions)=>{
    if(requestRef.current)return Promise.resolve(false);
    const focused=document.activeElement instanceof HTMLElement?document.activeElement:null;
    return new Promise<boolean>(resolve=>{const next={options,resolve,opener:focused};requestRef.current=next;setRequest(next)});
  },[]);
  useEffect(()=>{if(request)requestAnimationFrame(()=>{(request.options.tone==="danger"?cancelRef.current:confirmRef.current)?.focus()})},[request]);
  const keyDown=(event:KeyboardEvent<HTMLDivElement>)=>{
    if(event.key==="Escape"){event.preventDefault();event.stopPropagation();finish(false);return}
    if(event.key!=="Tab")return;
    const buttons=[...dialogRef.current!.querySelectorAll<HTMLElement>('button:not(:disabled),[href],input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex]:not([tabindex="-1"])')];
    if(!buttons.length){event.preventDefault();return}const first=buttons[0],last=buttons[buttons.length-1];
    if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus()}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus()}
  };
  return <Context.Provider value={confirmAction}>{children}{request&&createPortal(<div className="modal-overlay confirmation-overlay"><div ref={dialogRef} className="app-confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="app-confirm-title" onKeyDown={keyDown}><h2 id="app-confirm-title">{request.options.title??t("تأكيد")}</h2><p>{request.options.message}</p><div className="app-confirm-actions"><button ref={confirmRef} className={request.options.tone==="danger"?"danger":"primary"} onClick={()=>finish(true)}>{request.options.confirmLabel??t("متابعة")}</button><button ref={cancelRef} className="soft" onClick={()=>finish(false)}>{request.options.cancelLabel??t("إلغاء")}</button></div></div></div>,document.body)}</Context.Provider>;
}
export function useAppConfirm(){const value=useContext(Context);if(!value)throw new Error("useAppConfirm must be used inside ConfirmationProvider");return value}
