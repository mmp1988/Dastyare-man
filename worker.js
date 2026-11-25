const ALLOWED_ORIGIN = "https://mmp1988.github.io";
const MODEL = "@cf/zai-org/glm-4.7-flash";

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...extraHeaders
    }
  });
}

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin"
  };
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";

    if (request.method === "GET") {
      return json({
        success: true,
        service: "Mina Smart Brain",
        status: "ready"
      });
    }

    if (origin !== ALLOWED_ORIGIN) {
      return json({ success: false, error: "Origin not allowed" }, 403);
    }

    const headers = corsHeaders(origin);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers });
    }

    if (request.method !== "POST") {
      return json({ success: false, error: "Method not allowed" }, 405, headers);
    }

    try {
      const contentType = request.headers.get("Content-Type") || "";
      if (!contentType.toLowerCase().includes("application/json")) {
        return json({ success: false, error: "Content-Type must be application/json" }, 415, headers);
      }

      const rawBody = await request.text();
      if (rawBody.length > 12000) {
        return json({ success: false, error: "درخواست بیش از حد طولانی است." }, 413, headers);
      }

      const body = JSON.parse(rawBody);
      const message = typeof body.message === "string" ? body.message.trim() : "";

      if (!message || message.length > 4000) {
        return json({ success: false, error: "متن درخواست خالی یا بیش از حد طولانی است." }, 400, headers);
      }

      const result = await env.AI.run(MODEL, {
        messages: [
          {
            role: "system",
            content: "تو مینا هستی؛ دستیار فارسی‌زبان سالن زیبایی. با فارسی طبیعی، روان، صمیمی و دقیق پاسخ بده. منظور محاوره‌ای، غلط‌های تایپی و عبارت‌های رایج فارسی را تا حد ممکن بفهم. اگر اطلاعات لازم مبهم است، فقط سؤال روشن‌کننده بپرس و حدس نزن. زمان‌های فارسی و ساعت و دقیقه را دقیق تفسیر کن. هرگز ادعا نکن نوبت، مشتری، یادداشت یا داده‌ای را ثبت، ویرایش، جابه‌جا یا حذف کرده‌ای؛ این سرویس فقط پاسخ زبانی تولید می‌کند و اجرای عملیات باید جداگانه توسط برنامه و پس از اعتبارسنجی انجام شود. اگر از تو خواسته شد عملیات واقعی انجام دهی، اطلاعات لازم را ساختاریافته و روشن کن و اعلام کن که هنوز عملیاتی انجام نشده است."
          },
          { role: "user", content: message }
        ],
        max_completion_tokens: 512,
        temperature: 0.25
      });

      const reply = result?.response ?? result?.choices?.[0]?.message?.content ?? "";
      if (typeof reply !== "string" || !reply.trim()) {
        return json({ success: false, error: "پاسخ معتبری از مدل دریافت نشد." }, 502, headers);
      }

      return json({ success: true, reply }, 200, headers);
    } catch (error) {
      return json({
        success: false,
        error: "سرویس هوش مصنوعی فعلاً در دسترس نیست."
      }, 503, headers);
    }
  }
};
