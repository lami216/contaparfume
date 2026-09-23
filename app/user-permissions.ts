import { expandPermissionDependencies, removePermissionAndDependents } from "../lib/permission-dependencies";

export type PermissionAction = "view" | "create" | "edit" | "delete";

export const permissionRows: Array<{
  name: string;
  actions: Partial<Record<PermissionAction, string>>;
}> = [
  { name: "نقطة البيع", actions: { view: "pos.view", create: "pos.create", edit: "pos.edit", delete: "pos.delete" } },
  { name: "فواتير الشراء", actions: { view: "purchases.view", create: "purchases.create", edit: "purchases.edit", delete: "purchases.delete" } },
  { name: "سجل الفواتير", actions: { view: "records.view" } },
  { name: "المنتجات", actions: { view: "products.view", create: "products.create", edit: "products.edit", delete: "products.delete" } },
<<<<<<< /tmp/tmpu76shl6v/ours
  { name: "التقسيمات", actions: { view: "perfume.divisions.view", create: "perfume.divisions.manage" } },
  { name: "العملاء", actions: { view: "customers.view", create: "customers.create", edit: "customers.edit" } },
  { name: "الموردون", actions: { view: "suppliers.view", create: "suppliers.create", edit: "suppliers.edit" } },
  { name: "حساب العميل / التحصيل", actions: { view: "customers.view", create: "customers.collect" } },
  { name: "حساب المورد / الدفع", actions: { view: "suppliers.view", create: "suppliers.pay" } },
=======
  { name: "العملاء", actions: { view: "customers.view", create: "customers.create", edit: "customers.edit", delete: "customers.delete" } },
  { name: "الموردون", actions: { view: "suppliers.view", create: "suppliers.create", edit: "suppliers.edit", delete: "suppliers.delete" } },
  { name: "حساب العميل / التحصيل", actions: { view: "customers.view", create: "customers.collect", edit: "customers.collect.edit", delete: "customers.collect.delete" } },
  { name: "حساب المورد / الدفع", actions: { view: "suppliers.view", create: "suppliers.pay", edit: "suppliers.pay.edit", delete: "suppliers.pay.delete" } },
>>>>>>> /tmp/tmpu76shl6v/theirs
  { name: "المخازن", actions: { view: "warehouses.view", create: "warehouses.create", edit: "warehouses.edit", delete: "warehouses.delete" } },
  { name: "جرد المخزن", actions: { view: "warehouses.inventory.view" } },
  { name: "التحويل بين المخازن", actions: { create: "warehouses.transfer", edit: "warehouses.transfer.edit", delete: "warehouses.transfer.delete" } },
  { name: "تصحيح المخزون", actions: { create: "warehouses.adjust", edit: "warehouses.adjust.edit", delete: "warehouses.adjust.delete" } },
  { name: "البنوك ووسائل الدفع", actions: { view: "banks.view", create: "banks.create", edit: "banks.edit", delete: "banks.delete" } },
  { name: "حركة الحسابات", actions: { view: "banks.movements.view" } },
  { name: "التحويلات البنكية", actions: { view: "banks.view", create: "banks.transfer", edit: "banks.transfer.edit", delete: "banks.transfer.delete" } },
  { name: "السحب والإيداع", actions: { view: "banks.view", create: "banks.deposit_withdraw", edit: "banks.deposit_withdraw.edit", delete: "banks.deposit_withdraw.delete" } },
  { name: "تصحيح رصيد بنك/وسيلة دفع", actions: { view: "banks.view", create: "banks.balance_correct", edit: "banks.balance_correct.edit", delete: "banks.balance_correct.delete" } },
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
<<<<<<< /tmp/tmpu76shl6v/ours
    "products.view", "perfume.divisions.view", "perfume.divisions.manage", "customers.view", "customers.collect", "suppliers.view", "suppliers.pay",
    "warehouses.view", "warehouses.inventory.view", "banks.view", "banks.movements.view", "banks.transfer",
    "banks.deposit_withdraw", "expenses.view", "expenses.create", "expenses.edit", "reports.view",
=======
    "products.view", "customers.view", "customers.collect", "customers.collect.edit", "suppliers.view", "suppliers.pay", "suppliers.pay.edit",
    "warehouses.view", "warehouses.inventory.view", "warehouses.transfer", "warehouses.transfer.edit", "warehouses.adjust", "warehouses.adjust.edit",
    "banks.view", "banks.movements.view", "banks.transfer", "banks.transfer.edit", "banks.deposit_withdraw", "banks.deposit_withdraw.edit",
    "expenses.view", "expenses.create", "expenses.edit", "reports.view",
>>>>>>> /tmp/tmpu76shl6v/theirs
  ],
  sales: ["pos.view", "pos.create", "customers.create"],
};

export type AccountPreset = keyof typeof permissionPresets | "custom";
const samePermissions = (left: string[], right: string[]) =>
  left.length === right.length && left.every(permission => right.includes(permission));
export function detectPermissionPreset(permissions: string[]): AccountPreset {
  const normalized = expandPermissionDependencies([...new Set(permissions)]);
  for (const preset of ["manager", "accountant", "sales"] as const) {
    if (samePermissions(permissionPresets[preset], normalized)) return preset;
  }
  return "custom";
}

export function setPermission(permissions: string[], key: string, checked: boolean) {
  return checked
    ? expandPermissionDependencies([...permissions, key])
    : removePermissionAndDependents(permissions, key);
}

export function setRowFullControl(permissions: string[], keys: string[], checked: boolean) {
  if (checked) return expandPermissionDependencies([...permissions, ...keys]);
  const applicable = new Set(keys);
  return expandPermissionDependencies(permissions.filter(permission => !applicable.has(permission)));
}
