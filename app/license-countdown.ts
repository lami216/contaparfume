import type { Locale } from "./i18n/locale";
export function formatLicenseDuration(totalSeconds:number,locale:Locale){
  let remaining=Math.max(0,Math.floor(totalSeconds));
  const units=locale==="fr"?[{seconds:604800,label:"semaine"},{seconds:86400,label:"jour"},{seconds:3600,label:"heure"},{seconds:60,label:"minute"},{seconds:1,label:"seconde"}]:[{seconds:604800,label:"أسبوع"},{seconds:86400,label:"يوم"},{seconds:3600,label:"ساعة"},{seconds:60,label:"دقيقة"},{seconds:1,label:"ثانية"}];
  const parts:string[]=[];
  for(const unit of units){const value=Math.floor(remaining/unit.seconds);if(value>0)parts.push(`${value} ${unit.label}${locale==="fr"&&value!==1?"s":""}`);remaining%=unit.seconds}
  return parts.length?parts.join(" • "):locale==="fr"?"0 seconde":"0 ثانية";
}
