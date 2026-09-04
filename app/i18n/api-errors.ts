import type { Locale } from "./locale";

const exactFrench: Record<string, string> = {
  "اسم المستخدم غير صحيح": "Nom d’utilisateur incorrect",
  "كلمة المرور غير صحيحة": "Mot de passe incorrect",
  "طلب غير صالح": "Requête invalide",
  "تعذر تسجيل الدخول": "Connexion impossible",
  "تعذر تنفيذ العملية": "Impossible d’effectuer l’opération",
};

export function translateApiError(locale: Locale, message: string): string {
  if (locale === "ar") return message;
  const exact = exactFrench[message];
  if (exact) return exact;
  const insufficientBalance = message.match(/^الرصيد غير كافٍ في (.+)$/);
  if (insufficientBalance) return `Solde insuffisant sur ${insufficientBalance[1]}`;
  const insufficientStock = message.match(/^المخزون غير كافٍ للمنتج (.+)$/);
  if (insufficientStock) return `Stock insuffisant pour ${insufficientStock[1]}`;
  console.error("Unmapped API error", message);
  return "Une erreur est survenue. Veuillez réessayer.";
}
