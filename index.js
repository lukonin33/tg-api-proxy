/**
 * Telegram API Proxy
 * Перенаправляет запросы к api.telegram.org
 * Деплоить на Render.com как Web Service (Node.js)
 */
const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');

const app = express();
const PORT = process.env.PORT || 3000;

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// Проксируем всё на api.telegram.org
app.use('/', createProxyMiddleware({
  target: 'https://api.telegram.org',
  changeOrigin: true,
  secure: true,
  logLevel: 'warn',
  on: {
    error: (err, req, res) => {
      console.error('Proxy error:', err.message);
      res.status(502).json({ error: 'Proxy error', message: err.message });
    }
  }
}));

app.listen(PORT, () => {
  console.log(`Telegram API Proxy running on port ${PORT}`);
});
