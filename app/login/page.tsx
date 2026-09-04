"use client";
import { LoginExitButton } from "./login-exit-button";
import { LoginForm } from "./login-form";
import { APP_LOGO_ALT, APP_LOGO_PATH, APP_NAME } from "../../lib/app-brand";
import { Globe } from "lucide-react";
import { useI18n } from "../i18n/provider";

export default function Login() {
  const {locale,setLocale,t}=useI18n();
  return <main className="login"><div className="login-card"><button className="language-switch soft" type="button" onClick={()=>setLocale(locale==="ar"?"fr":"ar")}><Globe/>{locale==="ar"?"Français":"العربية"}</button><div className="login-brand"><img src={APP_LOGO_PATH} alt={APP_LOGO_ALT}/></div><h1>{APP_NAME}</h1><p className="login-title">{t("تسجيل الدخول")}</p><LoginForm exitButton={<LoginExitButton />}/></div></main>;
}
