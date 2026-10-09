const { addonBuilder } = require("stremio-addon-sdk");
const axios = require("axios");
const reshaper = require("arabic-reshaper");
const bidi = require("bidi-js");

const manifest = require("./manifest.json");
const builder = new addonBuilder(manifest);

const cache = new Map();

// 1. إصلاح العربية من السيرفر قبل إرسالها للهاتف
function fixArabic(text) {
  if (!text || !/[\u0600-\u06FF]/.test(text)) return text;
  try {
    const reshaped = reshaper.reshape(text);
    return bidi.getDisplay(reshaped);
  } catch (e) {
    return text;
  }
}

// 2. تحويل SRT إلى VTT صحيح لهاتف Stremio ExoPlayer
function srtToVtt(srt) {
  let vtt = "WEBVTT\n\n";
  const lines = srt.split("\n");
  for (const line of lines) {
    if (line.includes("-->")) {
      vtt += line.replace(/,/g, ".") + "\n";
    } else if (/^\d+$`/.test(line.trim()) && line.trim().length < 6) {
      continue;
    } else {
      vtt += fixArabic(line) + "\n";
    }
  }
  return vtt;
}

// 3. جلب الترجمة
builder.defineSubtitlesHandler(async ({ type, id }) => {
  const cacheKey = ``${type}:$`{id}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey);

  try {
    const imdbId = id.split(":")[0];
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4000);

    // غير هذا الرابط حسب مصدر الترجمة الخاص بك
    const response = await axios.get(`https://rest.opensubtitles.org/search/imdbid-`${imdbId.replace('tt','')}/language-ar`, {
      signal: controller.signal,
      headers: { "User-Agent": "SubtitleAR Mobile 1.0" },
      timeout: 4000
    });
    
    clearTimeout(timeout);

    if (!response.data || response.data.length === 0) {
      return { subtitles: [] };
    }

    const arabicSub = response.data.filter(s => s.lang === 'ar' || s.language === 'ar')[0] || response.data[0];
    const srtUrl = arabicSub.SubDownloadLink || arabicSub.url;
    
    if (!srtUrl) return { subtitles: [] };

    const proxyUrl = `https://$`{process.env.VERCEL_URL || 'localhost:' + (process.env.PORT || 7000)}/vtt?url=`${encodeURIComponent(srtUrl)}`;

    const result = {
      subtitles: [{
        id: "ar-fixed",
        url: proxyUrl,
        lang: "ar"
      }]
    };
    
    cache.set(cacheKey, result);
    setTimeout(() => cache.delete(cacheKey), 1000 * 60 * 60);
    return result;

  } catch (e) {
    return { subtitles: [] };
  }
});

const addonInterface = builder.getInterface();

// 4. سيرفر يعالج طلبات VTT + طلبات Stremio معاً
async function handler(req, res) {
  // مسار تحويل الترجمة لـ VTT للهاتف
  if (req.url.startsWith("/vtt?")) {
    try {
      const urlParams = new URL(req.url, "http://localhost");
      const srtUrl = urlParams.searchParams.get("url");
      if (!srtUrl) throw new Error("No url");

      const srtRes = await axios.get(srtUrl, {
        responseType: "arraybuffer",
        timeout: 4000
      });

      let srtContent = Buffer.from(srtRes.data).toString("utf-8");
      const vttContent = srtToVtt(srtContent);

      res.writeHead(200, {
        "Content-Type": "text/vtt; charset=utf-8",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "public, max-age=3600"
      });
      return res.end(vttContent);
    } catch (e) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      return res.end("Subtitle not found");
    }
  }
  
  // باقي الطلبات يعالجها Stremio SDK
  return addonInterface(req, res);
}

// للتشغيل المحلي
if (require.main === module) {
  const http = require("http");
  const port = process.env.PORT || 7000;
  http.createServer(handler).listen(port, () => {
    console.log("Addon running on http://127.0.0.1:" + port + "/manifest.json");
  });
}

// للرفع على Vercel
module.exports = handler;
