# tg-api-proxy

Stateless multi-API pass-through прокси плеяды. **Не хранит ключей** — клиент передаёт свой `Authorization`, прокси форвардит на upstream. Деплой: Render (primary, auto-deploy on push to `main`) + Timeweb Amsterdam VPS (secondary mirror `proxy.smm-ministr.ru`, Active-Passive failover).

## Маршруты

| Префикс | Upstream |
|---|---|
| `/anthropic/*` | api.anthropic.com |
| `/openai/*` | api.openai.com |
| `/deepseek/*` | api.deepseek.com |
| `/facebook/*` | graph.facebook.com |
| `/facebook/rupload/*` | rupload.facebook.com (IG resumable upload) |
| `/fal/*` | fal.run (sync) |
| `/fal-queue/*` | queue.fal.run |
| `/fal-media-v3/*`, `/fal-media-v3b/*` | v3/v3b.fal.media (CDN) |
| `/tme/<канал>` | парсер публичной превью t.me/s/<канал> (см. ниже) |
| `/health` | health-check |
| `/*` (default) | api.telegram.org (Telegram Bot API) |

## `/tme/<канал>` — формат ответа

```json
{
  "ok": true,
  "channel": { "title": "Pavel Durov", "subscribers_raw": "11M", "subscribers": 11000000 },
  "posts": [
    { "id": 524, "text": "...", "date": "2026-06-11T17:54:31+00:00", "views": 648000 }
  ]
}
```

- `posts[].id` — всегда присутствует (обратная совместимость со старым форматом `{ok, posts:[{id}]}`).
- `text` — текст поста (HTML очищен, `<br>`→перенос, entities декодированы); пустая строка для медиа-постов без подписи.
- `date` — ISO 8601 из атрибута `<time datetime>`.
- `views` — число (`"648K"`→648000); поле опускается, если просмотры не видны в публичной версии.
- `channel.subscribers_raw` — строка как на странице; `subscribers` — распарсенное число (или `null`).
- Лимит — последние 30 постов.

### ⚠️ enrich зависит от разметки t.me/s

Парсинг построен на разметке публичной веб-версии `t.me/s/<канал>` и **хрупок к её изменениям**. Защита:

- **Поштучная деградация:** если узел поля не найден — поле опускается, остальные сохраняются.
- **enrich_error:** при полном сбое (t.me недоступен / разметка не распозналась / канал без публичной превью) ответ отдаёт **старый формат** (`ok` + `posts` с одними `id`, либо пустой) и добавляет в корень поле `enrich_error` с краткой причиной (`tme_fetch_failed` / `parse_failed: <msg>` / `no_public_preview`).

При поломке enrich — смотреть `enrich_error`, сверять текущую разметку t.me/s с регулярками в `enrichTme()` (`index.js`).
