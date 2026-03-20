const http = require('http');
const https = require('https');
const url = require('url');

const PORT = process.env.PORT || 10000;
const TARGET = 'api.telegram.org';

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, {'Content-Type': 'application/json'});
    res.end(JSON.stringify({status: 'ok'}));
    return;
  }

  const options = {
    hostname: TARGET,
    port: 443,
    path: req.url,
    method: req.method,
    headers: { ...req.headers, host: TARGET },
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
  console.log(`Telegram proxy listening on 0.0.0.0:${PORT}`);
});
