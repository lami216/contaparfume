export type BackupSaveResult = { saved: boolean; canceled?: boolean; filePath?: string };
type BackupReply = { ok: boolean; canceled?: boolean; filePath?: string; code?: string; status?: number | null };
declare global {
  interface Window { alkarnaBackup?: { save: () => Promise<BackupReply> }; }
}
export async function exportNativeBackup(locale: 'ar' | 'fr'): Promise<BackupSaveResult> {
  if (window.alkarnaBackup) {
    const reply = await window.alkarnaBackup.save();
    if (reply.ok && reply.canceled) return { saved: false, canceled: true };
    if (!reply.ok || !reply.filePath) {
      const messages: Record<string, [string, string]> = {
        'backup-busy': ['انتظر انتهاء عملية النسخ الحالية.', 'Patientez pendant la sauvegarde en cours.'],
        ENOSPC: ['لا توجد مساحة كافية في المكان المختار.', 'Espace insuffisant à cet emplacement.'],
        EACCES: ['Windows منع الكتابة في المجلد المختار. اختر مجلدًا تملك صلاحية الحفظ فيه.', 'Windows refuse l’écriture dans ce dossier. Choisissez un dossier accessible.'],
        EPERM: ['Windows منع حفظ الملف أو استبداله. أغلق الملف إن كان مفتوحًا وجرّب اسمًا أو مجلدًا آخر.', 'Windows refuse l’enregistrement ou le remplacement. Fermez le fichier et essayez un autre nom ou dossier.'],
        EROFS: ['المكان المختار للقراءة فقط. اختر مكانًا آخر للحفظ.', 'Le support est en lecture seule. Choisissez un autre emplacement.'],
        ENOENT: ['المجلد أو الفلاشة لم يعد متاحًا. أعد توصيله واختر مكان الحفظ من جديد.', 'Le dossier ou le support n’est plus disponible. Reconnectez-le et choisissez à nouveau l’emplacement.'],
        ENODEV: ['انفصل وسيط التخزين أثناء الحفظ. أعد توصيله ثم أعد المحاولة.', 'Le support a été déconnecté. Reconnectez-le puis réessayez.'],
        'backup-write-timeout': ['لم تكتمل عملية النسخ خلال مهلة الحفظ. بقي التطبيق مفتوحًا؛ جرّب الحفظ في مجلد محلي. بيانات البرنامج لم تتغير.', 'La sauvegarde n’a pas été confirmée dans le délai imparti. L’application reste ouverte ; essayez un dossier local. Les données de l’application sont inchangées.'],
        'backup-worker-failed': ['توقف حفظ الملف قبل تأكيد اكتماله. جرّب الحفظ في مجلد محلي. بيانات البرنامج لم تتغير.', 'L’enregistrement s’est arrêté avant sa confirmation. Essayez un dossier local. Les données de l’application sont inchangées.'],
        'backup-target-changed': ['تغيّر الملف أثناء النسخ. لم نستبدله؛ أعد المحاولة باسم آخر.', 'Le fichier a changé. Il est conservé ; choisissez un autre nom.'],
        'invalid-backup-target': ['اختر اسمًا ينتهي بـ .conta.json أو .json.', 'Choisissez un nom se terminant par .conta.json ou .json.'],
      };
      const denied = reply.status === 401 || reply.status === 403;
      const message = denied ? ['لا تملك صلاحية النسخ أو انتهت الجلسة.', 'Permission absente ou session expirée.']
        : messages[reply.code ?? ''] ?? ['تعذر حفظ النسخة في المكان المختار. تحقق من الفلاشة والصلاحيات. لم تتغير البيانات.', 'Enregistrement impossible. Vérifiez le disque et les permissions. Les données sont inchangées.'];
      throw new Error(message[locale === 'fr' ? 1 : 0]);
    }
    return { saved: true, filePath: reply.filePath };
  }
  // Browser-only fallback; the desktop never enters Chromium's Blob downloader.
  const response = await fetch('/api/settings/backup');
  if (!response.ok) throw new Error(locale === 'ar' ? 'تعذر إنشاء النسخة' : 'Impossible de créer la sauvegarde');
  const link = document.createElement('a'), url = URL.createObjectURL(await response.blob());
  link.href = url;
  link.download = response.headers.get('content-disposition')?.match(/filename="([^"]+)/)?.[1] ?? 'conta-backup.conta.json';
  document.body.appendChild(link);
  try { link.click(); } finally {
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
  return { saved: false };
}
