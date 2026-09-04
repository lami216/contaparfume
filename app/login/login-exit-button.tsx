"use client";
import { useI18n } from "../i18n/provider";

export function LoginExitButton() {
  const {t}=useI18n();
  return <button className="login-exit" type="button" onClick={() => window.location.replace("about:blank")}>{t("خروج")}</button>;
}
