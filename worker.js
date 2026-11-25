// Cloudflare Workers entry point; this comment also verifies Git-connected deployment.
const ALLOWED_ORIGINS = new Set(["https://mmp1988.github.io", "https://appassets.androidplatform.net"]);
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
      return json({ success: true, status: "ready" });
    }

    if (!ALLOWED_ORIGINS.has(origin)) {
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

      // Keep Mina's public identity consistent and never disclose implementation details.
      // Curiosity about the underlying connection is redirected to the public Instagram shown on the site.
      const identityQuestion = /(?:تو\s*(?:کی|چی)\s*هستی|اسمت\s*چیه|نامت\s*چیه|خودت\s*رو\s*معرفی\s*کن|who\s+are\s+you|what\s+is\s+your\s+name)/i.test(message);
      const connectionQuestion = /(?:به\s*(?:چی|چه\s*(?:چیزی|هوش|مدل|سرویسی|جایی))\s*(?:وصل|متصل)\s*(?:هستی|ی|شدی)?|به\s*کجا\s*(?:وصلی|متصلی|وصل\s*هستی)|از\s*چه\s*(?:هوش|مدل|سرویس|شرکت|پلتفرم)\s*(?:استفاده\s*می\s*کنی|استفاده\s*میکنی)|چه\s*هوش\s*مصنوعی\s*ای\s*هستی|چه\s*مدلی\s*هستی|سازنده\s*ات\s*کیه|کجا\s*اجرا\s*می\s*شی|what\s+are\s+you\s+connected\s+to|which\s+model\s+are\s+you\s+using|what\s+ai\s+are\s+you)/i.test(message);
      if (identityQuestion || connectionQuestion) {
        const reply = "من مینا هستم، دستیار هوشمند امور سالن زیبایی. صفحه رسمی اینستاگرام: @lash_by_mina.m";
        return json({ success: true, reply }, 200, headers);
      }

      // Salon-only boundary: all salon features, promotions and app help are in scope.
      const scopeText = message.normalize("NFKC").replace(/[يى]/g, "ی").replace(/ك/g, "ک").replace(/[\u064B-\u065F\u0670]/g, "").replace(/\s+/g, " ");
      const salonDomainMessage = /(?:نوبت|رزرو|مشتری|پرونده|تولد|یادداشت|خدمت|تقویم|ترمیم|لیفت|کاشت|مژه|ابرو|ناخن|آرایش|سالن|متخصص|قیمت|تعرفه|هزینه|ساعت\s*کاری|یادآوری|بیعانه|پرداخت|رنگ\s*مو|وقت|ساعت|تاریخ|دقیقه|تایم|متن|پیام|تبریک|تخفیف|تبلیغ|کپشن|استوری|پست|کمپین|بازاریابی|مناسبت|جشن|ایده|شعار|معرفی|دعوت|اطلاع.?رسانی|راهنما|آموزش|تنظیمات|شخصی.?سازی|ظاهر|رنگ|فونت|سایت|اپلیکیشن|برنامه|گزارش|آمار|خروجی|پشتیبان|بکاپ|امکانات|قابلیت|کارکرد|appointment|booking|client|customer|lash|salon|service|calendar)/iu.test(scopeText);
      if (!salonDomainMessage) {
        const reply = "من مینا هستم؛ دستیار تخصصی امور سالن زیبایی. فقط در زمینه نوبت‌ها، مشتریان، خدمات و مدیریت سالن کمک می‌کنم و برای گفت‌وگوی عمومی طراحی نشده‌ام. برای اطلاعات و ارتباط بیشتر، صفحه اینستاگرام را ببینید: @lash_by_mina.m\nhttps://www.instagram.com/lash_by_mina.m/";
        return json({ success: true, reply }, 200, headers);
      }

      const understandMode = body.mode === "understand";
      const systemInstruction = understandMode
        ? "تو موتور فهم زبان فارسی مینا هستی. متن کاربر را به یک دستور فارسی روشن و کوتاه برای پردازشگر محلی برنامه بازنویسی کن. فقط یک شیء JSON معتبر و بدون markdown برگردان با کلید command. هیچ توضیح دیگری ننویس. منظور کاربر را تغییر نده، اطلاعاتی را حدس نزن و اگر درخواست مبهم است همان ابهام را حفظ کن. هر توکن داخل کروشه مانند [CLIENT_1] یا [PHONE_1] باید دقیقاً بدون تغییر در خروجی باقی بماند. هیچ نام یا شماره‌ای را حدس نزن یا جایگزین نکن. زمان‌ها، تاریخ‌ها و دقیقه‌ها را دقیقاً حفظ کن. این خروجی فقط پیشنهاد بازنویسی است و به معنی اجرای عملیات نیست."
        : "تو مینا هستی؛ دستیار تخصصی مدیریت سالن زیبایی، نه چت‌بات عمومی و نه همدم گفت‌وگو. فقط درباره تمام امور سالن و امکانات این برنامه کمک کن: ثبت و مدیریت نوبت‌ها، تاریخ و ساعت، تغییر و جابه‌جایی و لغو نوبت، مشتریان و پرونده‌ها، خدمات و قیمت‌ها، ترمیم، تولدها، یادداشت‌ها و یادآوری‌ها، نوشتن پیام تبریک و اطلاع‌رسانی، متن تبلیغاتی و تخفیف، کپشن و استوری، ایده‌های جذب مشتری، پاسخ به مشتری و راهنمای استفاده از سایت و اپ. فارسی محاوره‌ای، غلط تایپی و عبارت‌های رایج زمانی را دقیق بفهم؛ هیچ ساعت یا دقیقه‌ای را حدس نزن. اگر اطلاعات لازم مبهم است فقط یک سؤال روشن‌کننده بپرس. قیمت، مشخصات مشتری، زمان خالی یا اطلاعاتی را که در داده‌های برنامه نداری اختراع نکن. هرگز ادعا نکن عملیاتی انجام شده؛ ثبت، تغییر و حذف فقط با پردازشگر محلی برنامه و پس از تأیید کاربر انجام می‌شود. با گفت‌وگوی دوستانه یا پرسش نامرتبط وارد بحث نشو؛ کوتاه و محترمانه بگو فقط دستیار امور سالن هستی و آیدی @lash_by_mina.m را معرفی کن. هویت فنی، مدل، سرویس و زیرساخت پشت‌صحنه را افشا نکن.";

      const result = await env.AI.run(MODEL, {
        messages: [
          {
            role: "system",
            content: systemInstruction
          },
          { role: "user", content: message }
        ],
        max_completion_tokens: understandMode ? 256 : 512,
        temperature: understandMode ? 0.05 : 0.25
      });

      const reply = result?.response ?? result?.choices?.[0]?.message?.content ?? "";
      if (typeof reply !== "string" || !reply.trim()) {
        return json({ success: false, error: "پاسخ معتبری از مدل دریافت نشد." }, 502, headers);
      }

      if (understandMode) {
        let parsed;
        try {
          const cleaned = reply.trim().replace(/^\u0060{3}(?:json)?\s*/i, "").replace(/\s*\u0060{3}$/i, "");
          parsed = JSON.parse(cleaned);
        } catch {
          return json({ success: false, error: "بازنویسی معتبر دریافت نشد." }, 502, headers);
        }
        const command = typeof parsed.command === "string" ? parsed.command.trim() : "";
        if (!command || command.length > 4000) {
          return json({ success: false, error: "دستور بازنویسی‌شده معتبر نیست." }, 502, headers);
        }
        return json({ success: true, command }, 200, headers);
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
