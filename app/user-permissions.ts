export type PermissionAction = "view" | "create" | "edit" | "delete";

export const permissionRows: Array<{
  name: string;
  actions: Partial<Record<PermissionAction, string>>;
}> = [
  { name: "نقطة البيع", actions: { view: "pos.view", create: "pos.create", edit: "pos.edit", delete: "pos.delete" } },
  { name: "فواتير الشراء", actions: { view: "purchases.view", create: "purchases.create", edit: "purchases.edit", delete: "purchases.delete" } },
  { name: "سجل الفواتير", actions: { view: "records.view" } },
  { name: "المنتجات", actions: { view: "products.view", create: "products.create", edit: "products.edit", delete: "products.delete" } },
  { name: "العملاء", actions: { view: "customers.view", create: "customers.create", edit: "customers.edit" } },
  { name: "الموردون", actions: { view: "suppliers.view", create: "suppliers.create", edit: "suppliers.edit" } },
  { name: "حساب العميل / التحصيل", actions: { view: "customers.view", create: "customers.collect" } },
  { name: "حساب المورد / الدفع", actions: { view: "suppliers.view", create: "suppliers.pay" } },
  { name: "المخازن", actions: { view: "warehouses.view", create: "warehouses.create", edit: "warehouses.edit", delete: "warehouses.delete" } },
  { name: "جرد المخزن", actions: { view: "warehouses.inventory.view" } },
  { name: "التحويل بين المخازن", actions: { create: "warehouses.transfer" } },
  { name: "تصحيح المخزون", actions: { create: "warehouses.adjust" } },
  { name: "البنوك ووسائل الدفع", actions: { view: "banks.view", create: "banks.create", edit: "banks.edit", delete: "banks.delete" } },
  { name: "حركة الحسابات", actions: { view: "banks.movements.view" } },
  { name: "التحويلات البنكية", actions: { view: "banks.view", create: "banks.transfer" } },
  { name: "السحب والإيداع", actions: { view: "banks.view", create: "banks.deposit_withdraw" } },
  { name: "تصحيح رصيد بنك/وسيلة دفع", actions: { view: "banks.view", create: "banks.balance_correct" } },
  { name: "المصاريف", actions: { view: "expenses.view", create: "expenses.create", edit: "expenses.edit", delete: "expenses.delete" } },
  { name: "التقارير", actions: { view: "reports.view" } },
  { name: "الإعدادات", actions: { view: "settings.view" } },
  { name: "هوية النشاط والمستندات", actions: { edit: "settings.branding.manage" } },
  { name: "النسخ الاحتياطي والاستعادة", actions: { create: "settings.backup.manage" } },
  { name: "استيراد النظام السابق", actions: { create: "settings.legacy.import" } },
  { name: "المستخدمون والصلاحيات", actions: { create: "settings.users.manage" } },
];

export const allPermissions = [...new Set(permissionRows.flatMap(row => Object.values(row.actions)))];
export const permissionPresets = {
  manager: allPermissions,
  accountant: [
    "purchases.view", "purchases.create", "purchases.edit", "records.view",
    "products.view", "customers.view", "customers.collect", "suppliers.view", "suppliers.pay",
    "warehouses.view", "warehouses.inventory.view", "banks.view", "banks.movements.view", "banks.transfer",
    "banks.deposit_withdraw", "expenses.view", "expenses.create", "expenses.edit", "reports.view",
  ],
  sales: ["pos.view", "pos.create", "customers.create"],
};

export type AccountPreset = keyof typeof permissionPresets | "custom";
const samePermissions = (left: string[], right: string[]) =>
  left.length === right.length && left.every(permission => right.includes(permission));
export function detectPermissionPreset(permissions: string[]): AccountPreset {
  for (const preset of ["manager", "accountant", "sales"] as const) {
    if (samePermissions(permissionPresets[preset], [...new Set(permissions)])) return preset;
  }
  return "custom";
}

export function setPermission(permissions: string[], key: string, checked: boolean) {
  return checked ? [...new Set([...permissions, key])] : permissions.filter(permission => permission !== key);
}

export function setRowFullControl(permissions: string[], keys: string[], checked: boolean) {
  const applicable = new Set(keys);
  return checked
    ? [...new Set([...permissions, ...keys])]
    : permissions.filter(permission => !applicable.has(permission));
}
