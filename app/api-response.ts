export type ApiPayload = Record<string, unknown>;

const statusMessage = (status: number) => {
  if (status === 413) return "حجم الملف تجاوز الحد المسموح به في خادم الويب.";
  if (status === 404) return "مسار الاستيراد غير متاح في النسخة الحالية.";
  if (status === 408 || status === 504) return "انتهت مهلة الطلب. ستستمر عملية الاستيراد ويمكن متابعة حالتها.";
  if (status === 429) return "طلبات كثيرة. انتظر قليلًا ثم تابع حالة الاستيراد.";
  if (status === 500) return "حدث خطأ في الخادم. استخدم رقم عملية الاستيراد عند التواصل مع الدعم.";
  if (status === 502 || status === 503) return "تعذر الوصول إلى خادم التطبيق.";
  return "تعذر إكمال الطلب. حاول مرة أخرى.";
};

/** Parses API responses without ever exposing proxy HTML or JSON parser errors. */
export async function readApiResponse(response: Response): Promise<ApiPayload> {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  const body = await response.text();
  let payload: ApiPayload = {};
  if (contentType.includes("application/json") && body) {
    try { payload = JSON.parse(body) as ApiPayload; } catch { payload = {}; }
  }
  if (!response.ok) {
    const apiError = typeof payload.error === "string" ? payload.error : "";
    throw new Error(apiError || statusMessage(response.status));
  }
  if (!contentType.includes("application/json")) throw new Error(statusMessage(response.status));
  return payload;
}
