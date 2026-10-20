import type { Locale } from "./locale";

const exactFrench: Record<string, string> = {
  "لا يمكن تعديل أو إلغاء العملية لأن لها حركات لاحقة. ألغِ الحركات المرتبطة الأحدث أولًا.": "Des opérations ultérieures dépendent de celle-ci. Annulez-les d’abord.",
  "العملية ملغاة أو تم تعديلها. افتح أحدث سجل.": "Cette opération est annulée ou remplacée. Ouvrez sa dernière version.",
  "تغيرت العملية. حدّث الصفحة وأعد المحاولة.": "L’opération a changé. Actualisez la page.",
  "تغيرت الزجاجة. حدّث الصفحة وأعد المحاولة.": "Le flacon a changé. Actualisez la page.",
  "لا يمكن أرشفة زجاجة لها مخزون. صحح الرصيد أو انقل الكميات أولًا.": "Impossible d’archiver un flacon en stock. Corrigez ou transférez ses quantités d’abord.",
  "استخدم إدارة التقسيمات لتعديل أو إلغاء هذه العملية حتى تبقى الدفعات متطابقة.": "Modifiez ou annulez cette opération dans la gestion des décants pour préserver la cohérence des lots.",
  "لا يمكن إلغاء الحركة لأن دفعة التقسيم تغيرت بعدها. ألغِ الحركات الأحدث أولًا.": "Le lot a changé depuis cette opération. Annulez les opérations suivantes d’abord.",
  "لا يوجد فرق في ناتج التقسيم لاعتماده": "Le rendement n’a pas changé.",
  "لا يمكن تصفير دفعة لها قيمة بتصحيح الناتج؛ استخدم استهلاك/هالك التقسيمات": "Pour supprimer un stock ayant une valeur, utilisez la consommation ou les pertes.",
  "يجب جمع كل التقسيمات المتبقية في مخزن واحد قبل إرجاعها": "Regroupez tous les décants restants dans un seul dépôt avant cette opération.",
  "الكمية أكبر من رصيد الدفعة": "La quantité dépasse le stock du lot.",
  "لا توجد تكلفة شراء معتمدة لهذا العطر": "Ce parfum ne dispose pas de coût d’achat validé.",
  "لا توجد تكلفة شراء معتمدة للزجاجة": "Ce flacon ne dispose pas de coût d’achat validé.",
  "زجاجة بنفس الاسم والحجم موجودة بالفعل": "Un flacon de même nom et contenance existe déjà.",
  "اسم الزجاجة غير صالح": "Nom du flacon non valide.",
  "استعد الزجاجة من الأرشيف قبل تعديلها": "Restaurez le flacon archivé avant de le modifier.",
  "الزجاجة نشطة بالفعل": "Ce flacon est déjà actif.",
  "اختر زجاجة نشطة": "Choisissez un flacon actif.",
  "سبب التصحيح مطلوب": "Indiquez le motif de correction.",

  "اسم المستخدم غير صحيح": "Nom d’utilisateur incorrect",
  "كلمة المرور غير صحيحة": "Mot de passe incorrect",
  "طلب غير صالح": "Requête invalide",
  "تعذر تسجيل الدخول": "Connexion impossible",
  "تعذر تنفيذ العملية": "Impossible d’effectuer l’opération",
  "اسم الفئة مطلوب": "Le nom de la catégorie est obligatoire",
  "اسم الفئة طويل جدًا": "Le nom de la catégorie est trop long",
  "هذه الفئة موجودة بالفعل": "Cette catégorie existe déjà",
  "الفئة غير موجودة": "Catégorie introuvable",
  "رمز العملة يجب أن يتكون من 3 أحرف إنجليزية": "Le code de devise doit contenir exactement 3 lettres anglaises",
  "قائمة العملات غير صالحة": "La liste des devises n’est pas valide",
  "عدد العملات المحفوظة كبير جدًا": "Trop de devises enregistrées",
  "تعذر حفظ العملة": "Impossible d’enregistrer la devise",
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
