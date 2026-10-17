// ULTRON - Cloudflare Worker (API anahtarını gizli tutar)
// Worker > Settings > Variables and Secrets:
//   ANTHROPIC_API_KEY  (Secret, zorunlu)
//   ULTRON_TOKEN       (Secret, önerilir: ayarlardaki "Erişim şifresi" ile aynı olmalı)
//   MODEL              (isteğe bağlı, varsayılan claude-sonnet-5-5)

const SYSTEM = "Sen ULTRON'sun: sakin, güçlü, zeki, JARVIS tarzı bir yapay zekâ asistansın. " +
  "Kullanıcıya her zaman Türkçe, kısa ve net cevap ver. Cevapların sesli okunacak; " +
  "markdown, emoji, madde işareti ve uzun listeler kullanma. Doğal konuşma cümleleri kur. " +
  "Fotoğraf gelirse içeriğini dürüstçe ve kısaca analiz et. Bilmediğin şeyi uydurma.";

export default {
  async fetch(req, env) {
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type,X-Ultron-Token",
      "Access-Control-Allow-Methods": "POST,OPTIONS",
    };
    const json = (o, s = 200) =>
      new Response(JSON.stringify(o), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

    if (req.method === "OPTIONS") return new Response(null, { headers: cors });
    if (req.method !== "POST") return new Response("ULTRON hazır.", { headers: cors });
    if (env.ULTRON_TOKEN && req.headers.get("X-Ultron-Token") !== env.ULTRON_TOKEN)
      return json({ error: "Erişim şifresi hatalı" }, 401);
    if (!env.ANTHROPIC_API_KEY) return json({ error: "Worker'da ANTHROPIC_API_KEY tanımlı değil" }, 500);

    let body;
    try { body = await req.json(); } catch { return json({ error: "Geçersiz istek" }, 400); }

    // Mesajları temizle: user ile başlasın, roller sırayla gitsin
    const msgs = [];
    for (const m of (body.messages || [])) {
      const role = m.role === "assistant" ? "assistant" : "user";
      const text = String(m.content || "").slice(0, 4000);
      if (!text) continue;
      if (!msgs.length && role !== "user") continue;
      const last = msgs[msgs.length - 1];
      if (last && last.role === role) last.content += "\n" + text;
      else msgs.push({ role, content: text });
    }
    if (!msgs.length) return json({ error: "Mesaj yok" }, 400);

    if (body.image && typeof body.image === "string" && body.image.startsWith("data:image/")) {
      const m = body.image.match(/^data:(image\/[a-z+]+);base64,(.+)$/);
      const last = msgs[msgs.length - 1];
      if (m && last.role === "user") {
        last.content = [
          { type: "image", source: { type: "base64", media_type: m[1], data: m[2] } },
          { type: "text", text: last.content },
        ];
      }
    }

    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: env.MODEL || "claude-sonnet-5-5",
        max_tokens: 600,
        system: SYSTEM,
        messages: msgs,
      }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) return json({ error: (data.error && data.error.message) || "Anthropic hatası " + r.status }, 502);
    const reply = (data.content || []).filter(c => c.type === "text").map(c => c.text).join(" ").trim();
    return json({ reply });
  },
};
