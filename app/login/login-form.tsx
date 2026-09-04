"use client";
import { type FormEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useI18n } from "../i18n/provider";
import { translateApiError } from "../i18n/api-errors";

export function LoginForm({exitButton}:{exitButton:ReactNode}) {
  const {t,locale}=useI18n();
  const [username,setUsername]=useState(""),[password,setPassword]=useState(""),[error,setError]=useState(""),[submitting,setSubmitting]=useState(false);
  const usernameRef=useRef<HTMLInputElement>(null),passwordRef=useRef<HTMLInputElement>(null),router=useRouter();
  useEffect(()=>{if(!error)return;const timer=window.setTimeout(()=>setError(""),2800);return()=>window.clearTimeout(timer)},[error]);
  async function submit(event:FormEvent<HTMLFormElement>){
    event.preventDefault();setSubmitting(true);setError("");
    try {
      const body=new FormData();body.set("username",username);body.set("password",password);
      const response=await fetch("/api/auth/login",{method:"POST",headers:{"x-alkarna-login-ui":"1"},body});
      const result=await response.json() as {ok:boolean;field?:"username"|"password";error?:string};
      if(response.ok&&result.ok){router.replace("/");router.refresh();return}
      setError(translateApiError(locale,result.error??"تعذر تسجيل الدخول"));
      if(result.field==="username"){setUsername("");requestAnimationFrame(()=>usernameRef.current?.focus())}
      else if(result.field==="password"){setPassword("");requestAnimationFrame(()=>passwordRef.current?.focus())}
    } catch {setError(t("تعذر الاتصال بالتطبيق"))} finally {setSubmitting(false)}
  }
  return <form onSubmit={submit}><label>{t("اسم المستخدم")}<input ref={usernameRef} name="username" required autoComplete="username" value={username} onChange={event=>setUsername(event.target.value)}/></label><label>{t("كلمة المرور")}<input ref={passwordRef} name="password" type="password" required autoComplete="current-password" value={password} onChange={event=>setPassword(event.target.value)}/></label>{error&&<p className="login-error" role="alert">{error}</p>}<div className="login-actions"><button className="login-submit" type="submit" disabled={submitting}>{submitting?t("جارٍ الدخول..."):t("تسجيل الدخول")}</button>{exitButton}</div></form>
}
