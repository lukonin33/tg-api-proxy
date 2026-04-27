const http = require('http');
const https = require('https');
const PORT = process.env.PORT || 10000;
const TG_TARGET = 'api.telegram.org';

// LLM upstream targets (pass-through proxy — клиент шлёт свой Authorization, прокси не хранит ключи)
const LLM_TARGETS = {
  '/anthropic/': 'api.anthropic.com',
  '/openai/':    'api.openai.com',
  '/deepseek/':  'api.deepseek.com',
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

const server = http.createServer((req, res) => {
  // Health check
  if (req.url === '/health') {
    res.writeHead(200, {'Content-Type': 'application/json'});
    res.end(JSON.stringify({status: 'ok', routes: ['/anthropic/*', '/openai/*', '/deepseek/*', '/tme/:channel', '/* (telegram bot api default)']}));
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
      proxyRes.on('data', chunk => data += chunk);
      proxyRes.on('end', () => {
        const matches = [...data.matchAll(/data-post="[^/]+\/(\d+)"/g)];
        const posts = matches.map(m => ({ id: parseInt(m[1]) }));
        res.writeHead(200, {'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*'});
        res.end(JSON.stringify({ ok: true, posts }));
      });
    });
    proxy.on('error', (err) => {
      res.writeHead(502);
      res.end(JSON.stringify({ ok: false, error: err.message }));
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
