const http = require('http');
const https = require('https');
const PORT = process.env.PORT || 10000;
const TG_TARGET = 'api.telegram.org';

// LLM upstream targets (pass-through proxy — клиент шлёт свой Authorization, прокси не хранит ключи)
// Order matters: more-specific prefixes (e.g. '/facebook/rupload/') must come BEFORE generic ones ('/facebook/')
const LLM_TARGETS = {
  '/anthropic/':         'api.anthropic.com',
  '/openai/':            'api.openai.com',
  '/deepseek/':          'api.deepseek.com',
  '/facebook/rupload/':  'rupload.facebook.com',  // Resumable Upload API for IG (bypass error 2207052)
  '/facebook/':          'graph.facebook.com',
  // 2026-05-29: fal.ai routes — workaround flaky fal.media CDN из РФ YC NSK.
  // fal.run — sync API endpoint (matches content-factory workflow nodes)
  // queue.fal.run — async queue API (для других use cases)
  // v3b.fal.media / v3.fal.media — binary CDN для download'a сгенерированных файлов
  '/fal/':               'fal.run',
  '/fal-queue/':         'queue.fal.run',
  '/fal-media-v3b/':     'v3b.fal.media',
  '/fal-media-v3/':      'v3.fal.media',
};

function passThrough(req, res, hostname, upstreamPath) {
  const headers = { ...req.headers, host: hostname };
  // Render adds x-forwarded-* — upstream API не любит лишние, оставляем но не критично
  const opts = { hostname, port: 443, path: upstreamPath, method: req.method, headers };
  const proxy = https.request(opts, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res, { end: true });
  });
  proxy.on('error', (err) => {
    res.writeHead(502, {'Content-Type': 'application/json'});
    res.end(JSON.stringify({ error: 'upstream_error', message: err.message, upstream: hostname }));
  });
  req.pipe(proxy, { end: true });
}

// --- t.me/s public-preview enrichment helpers (zero-dependency) ---
// ВНИМАНИЕ: парсинг зависит от разметки t.me/s/<канал>. При изменении вёрстки
// Telegram поля деградируют поштучно (узел не найден → поле опущено), а при полном
// сбое маршрут отдаёт старый формат (ids) + enrich_error. См. README раздел /tme.
function decodeEntities(s) {
  return String(s)
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (m, d) => { try { return String.fromCodePoint(parseInt(d, 10)); } catch (e) { return m; } })
    .replace(/&#x([0-9a-fA-F]+);/g, (m, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch (e) { return m; } });
}

function htmlToText(html) {
  const s = String(html)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div)>/gi, '\n')
    .replace(/<[^>]+>/g, '');
  return decodeEntities(s).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

// "11M" → 11000000, "3.76M" → 3760000, "12.3K" → 12300, "12,345" → 12345, "189" → 189
function parseCount(raw) {
  if (raw == null) return null;
  const m = String(raw).trim().match(/^([\d.,\s]+?)\s*([KMB])?$/i);
  if (!m) return null;
  const n = parseFloat(m[1].replace(/[\s,]/g, ''));
  if (!Number.isFinite(n)) return null;
  const mult = { K: 1e3, M: 1e6, B: 1e9 }[(m[2] || '').toUpperCase()] || 1;
  return Math.round(n * mult);
}

// Парсит публичную превью t.me/s. Возвращает { posts, channel }. Может бросить —
// вызывающий ловит и деградирует к ids-only + enrich_error.
function enrichTme(html) {
  const titleM = html.match(/<meta property="og:title" content="([^"]*)"/);
  const subM = html.match(/counter_value">([^<]+)<\/span>\s*<span class="counter_type">subscribers/i);
  const subscribers_raw = subM ? decodeEntities(subM[1]).trim() : null;
  const channel = {
    title: titleM ? decodeEntities(titleM[1]).trim() : null,
    subscribers_raw: subscribers_raw,
    subscribers: subscribers_raw ? parseCount(subscribers_raw) : null,
  };

  const chunks = html.split('tgme_widget_message_wrap').slice(1);
  const posts = [];
  for (const ch of chunks) {
    const idM = ch.match(/data-post="[^"/]+\/(\d+)"/);
    if (!idM) continue;
    const post = { id: parseInt(idM[1], 10) };
    const textM = ch.match(/tgme_widget_message_text[^>]*>([\s\S]*?)<\/div>/);
    post.text = textM ? htmlToText(textM[1]) : '';
    const dateM = ch.match(/<time[^>]*datetime="([^"]+)"/);
    if (dateM) post.date = dateM[1];
    const viewsM = ch.match(/tgme_widget_message_views"[^>]*>([^<]+)</);
    if (viewsM) {
      const v = parseCount(viewsM[1]);
      if (v != null) post.views = v;
    }
    posts.push(post);
  }
  return { posts: posts.slice(-30), channel: channel };
}

const server = http.createServer((req, res) => {
  // Health check
  if (req.url === '/health') {
    res.writeHead(200, {'Content-Type': 'application/json'});
    res.end(JSON.stringify({status: 'ok', routes: ['/anthropic/*', '/openai/*', '/deepseek/*', '/facebook/*', '/fal/* (sync)', '/fal-queue/*', '/fal-media-v3/*', '/fal-media-v3b/*', '/tme/:channel', '/* (telegram bot api default)']}));
    return;
  }

  // LLM proxy routes — strip prefix and forward to upstream
  for (const [prefix, hostname] of Object.entries(LLM_TARGETS)) {
    if (req.url.startsWith(prefix)) {
      const upstreamPath = req.url.slice(prefix.length - 1); // оставляем ведущий /
      return passThrough(req, res, hostname, upstreamPath);
    }
  }

  // Парсинг публичного канала t.me/s/:channel
  const tmeMatch = req.url.match(/^\/tme\/([a-zA-Z0-9_]+)$/);
  if (tmeMatch) {
    const channel = tmeMatch[1];
    const opts = {
      hostname: 't.me',
      port: 443,
      path: `/s/${channel}`,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1)',
        'Accept': 'text/html',
      }
    };
    const proxy = https.request(opts, (proxyRes) => {
      let data = '';
      proxyRes.setEncoding('utf8'); // не бить кириллицу/эмодзи на границе чанков
      proxyRes.on('data', chunk => data += chunk);
      proxyRes.on('end', () => {
        // backward-compat: ids извлекаем старой регуляркой ДО обогащения —
        // гарантируем старый формат, даже если enrichTme бросит.
        let posts = [...data.matchAll(/data-post="[^/]+\/(\d+)"/g)].map(m => ({ id: parseInt(m[1]) }));
        let channel = null;
        let enrich_error = null;
        try {
          const enriched = enrichTme(data);
          posts = enriched.posts;       // те же id + text/date/views, лимит 30
          channel = enriched.channel;
          if (posts.length === 0) enrich_error = 'no_public_preview';
        } catch (e) {
          enrich_error = 'parse_failed: ' + (e && e.message ? e.message : 'unknown');
        }
        const body = { ok: true, posts: posts };
        if (channel) body.channel = channel;
        if (enrich_error) body.enrich_error = enrich_error;
        res.writeHead(200, {'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*'});
        res.end(JSON.stringify(body));
      });
    });
    proxy.on('error', (err) => {
      // graceful degradation: пустой старый формат + enrich_error (раньше — 502)
      res.writeHead(200, {'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*'});
      res.end(JSON.stringify({ ok: false, posts: [], error: err.message, enrich_error: 'tme_fetch_failed' }));
    });
    proxy.end();
    return;
  }

  // Default: проксирование Telegram Bot API
  const options = {
    hostname: TG_TARGET,
    port: 443,
    path: req.url,
    method: req.method,
    headers: { ...req.headers, host: TG_TARGET },
  };
  const proxy = https.request(options, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res, { end: true });
  });
  proxy.on('error', (err) => {
    res.writeHead(502);
    res.end(JSON.stringify({ error: err.message }));
  });
  req.pipe(proxy, { end: true });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Multi-API proxy listening on 0.0.0.0:${PORT}`);
  console.log(`Routes: /anthropic/* → api.anthropic.com, /openai/* → api.openai.com, /deepseek/* → api.deepseek.com, /tme/:channel, /* → ${TG_TARGET}`);
});
