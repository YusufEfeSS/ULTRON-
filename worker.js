// ULTRON - Cloudflare Worker (API anahtarını gizli tutar)
// Secret'lar (Settings > Variables and Secrets):
//   GEMINI_API_KEY     (ÜCRETSİZ yol: aistudio.google.com/apikey)  -- veya --
//   ANTHROPIC_API_KEY  (ücretli yol)
//   ULTRON_TOKEN       (kendi şifren; uygulamadaki "Erişim şifresi" ile aynı)
// Değişken (isteğe bağlı): MODEL  (Gemini için varsayılan gemini-2.5-flash)

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
    if (req.method !== "POST") {
      // Arayüz dosyaları (index.html) aynı adresten sunulur
      return env.ASSETS ? env.ASSETS.fetch(req) : new Response("ULTRON hazır.", { headers: cors });
    }
    if (env.ULTRON_TOKEN && req.headers.get("X-Ultron-Token") !== env.ULTRON_TOKEN)
      return json({ error: "Erişim şifresi hatalı" }, 401);
    if (!env.GEMINI_API_KEY && !env.ANTHROPIC_API_KEY)
      return json({ error: "Worker'da GEMINI_API_KEY (veya ANTHROPIC_API_KEY) tanımlı değil" }, 500);

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
      if (last && last.role === role) last.text += "\n" + text;
      else msgs.push({ role, text });
    }
    if (!msgs.length) return json({ error: "Mesaj yok" }, 400);

    let img = null;
    if (typeof body.image === "string") {
      const m = body.image.match(/^data:(image\/[a-z+]+);base64,(.+)$/);
      if (m) img = { mime: m[1], data: m[2] };
    }

    try {
      const reply = env.GEMINI_API_KEY
        ? await gemini(env, msgs, img)
        : await anthropic(env, msgs, img);
      return json({ reply: reply || "Boş yanıt aldım." });
    } catch (e) {
      return json({ error: String(e.message || e) }, 502);
    }
  },
};

async function gemini(env, msgs, img) {
  const model = env.MODEL || "gemini-2.5-flash";
  const contents = msgs.map((m, i) => {
    const parts = [{ text: m.text }];
    if (img && i === msgs.length - 1 && m.role === "user")
      parts.unshift({ inlineData: { mimeType: img.mime, data: img.data } });
    return { role: m.role === "assistant" ? "model" : "user", parts };
  });
  const r = await fetch(
    "https://generativelanguage.googleapis.com/v1beta/models/" + encodeURIComponent(model) + ":generateContent",
    {
      method: "POST",
      headers: { "x-goog-api-key": env.GEMINI_API_KEY, "content-type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM }] },
        contents,
        generationConfig: { maxOutputTokens: 700 },
      }),
    }
  );
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error("Gemini: " + ((data.error && data.error.message) || r.status));
  const parts = (((data.candidates || [])[0] || {}).content || {}).parts || [];
  return parts.map(p => p.text || "").join(" ").trim();
}

async function anthropic(env, msgs, img) {
  const messages = msgs.map((m, i) => {
    if (img && i === msgs.length - 1 && m.role === "user")
      return { role: "user", content: [
        { type: "image", source: { type: "base64", media_type: img.mime, data: img.data } },
        { type: "text", text: m.text } ] };
    return { role: m.role, content: m.text };
  });
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: env.MODEL || "claude-sonnet-5-5", max_tokens: 600, system: SYSTEM, messages }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error("Anthropic: " + ((data.error && data.error.message) || r.status));
  return (data.content || []).filter(c => c.type === "text").map(c => c.text).join(" ").trim();
}
