const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');

const app = express();
const PORT = process.env.PORT || 10000;

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.use('/', createProxyMiddleware({
  target: 'https://api.telegram.org',
  changeOrigin: true,
  secure: true,
  logLevel: 'warn',
  on: {
    error: (err, req, res) => {
      res.status(502).json({ error: 'Proxy error', message: err.message });
    }
  }
}));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Telegram API Proxy running on port ${PORT}`);
});
