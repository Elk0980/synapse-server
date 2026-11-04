# Palitra Love — подключение домена palitra-love.ru (подготовка, не выполнено)

Статус на 18.09.2026: **домен не подключён**. Ниже точный план и заготовки, чтобы переключение заняло одну итерацию, когда появится доступ к зоне DNS. Ничего из этого документа на сервере и в DNS ещё не применено.

## 1. Факты (проверены read-only 18.09.2026)

| Что | Значение | Как проверено |
| --- | --- | --- |
| Домен | `palitra-love.ru`, зарегистрирован Анной в REG.RU 01.09.2026 | итоги встречи 04.09, скриншот в чате |
| A apex | `95.163.244.138` | системный резолвер, 18.09 |
| A www | `95.163.244.138` | системный резолвер, 18.09 |
| AAAA | не найден | проверка 17.09 (Хью); 18.09 DoH-запросы из песочницы недоступны |
| NS | `ns1.reg.ru`, `ns2.reg.ru` | проверка 17.09 (Хью) |
| MX / TXT / SPF / DKIM / DMARC | **не прочитаны** | прочитать в зоне перед любым изменением; не трогать |
| Что отвечает 95.163.244.138 | HTTP и HTTPS: таймаут соединения (15 с) | 18.09 |
| Сервер Synapse Business | `72.56.249.147` (Timeweb VM 8936001, `/opt/synapse`) | координационный файл |
| Текущий публичный адрес сайта | `https://palitra-love.synapsebusiness.ru` | Caddyfile, блок с корнем `/srv/sites/palitra-love` |

Вывод: DNS ведёт на чужой/неактивный адрес. Это не подключение к Sb. Подтверждённым считается только результат проверок из раздела 5.

## 2. Что нужно от владельца домена (блокер)

Один из вариантов, на выбор Анны/Влада:

1. Анна сама вносит в зоне REG.RU две записи из раздела 3 (по готовой инструкции), или
2. Влад входит в REG.RU под аккаунтом Анны и вносит их.

Пароль/код в чат не запрашивать. Вопрос Анне уже отправлен ботом 17.09 17:47:36 (TG 52), напоминать без её ответа нельзя.

## 3. Изменения DNS (только веб-имена)

Перед сохранением перечитать существующую зону целиком и сохранить снимок (скриншот или экспорт).

| Имя | Тип | Было | Станет | TTL |
| --- | --- | --- | --- | --- |
| `@` (`palitra-love.ru`) | A | `95.163.244.138` | `72.56.249.147` | 600 (на время переключения), потом стандартный |
| `www` | A | `95.163.244.138` | `72.56.249.147` | 600 |

Правила:
- AAAA для `@` и `www` не добавлять и, если появятся, удалить конфликтующие: у сервера Sb нет подтверждённого публичного IPv6 для Caddy.
- `www` оставить записью A, не CNAME на apex (CNAME на apex у REG.RU для `@` невозможен, а для `www` A проще и не зависит от других записей).
- MX, TXT (SPF/DKIM/DMARC), NS, SRV и любые другие записи не менять. Если почта на домене есть, она продолжит работать.
- Никаких переносов NS и покупок домена.

## 4. Изменения сервера (готовый блок Caddy)

Применяются коммитом в `caddy/Caddyfile` через обычный PR **только после** того, как DNS уже указывает на `72.56.249.147` и это подтверждено `dig`/`nslookup` с внешнего резолвера. Иначе Caddy начнёт запрашивать сертификат для имени, которое ещё не ведёт на сервер, и будет копить ошибки ACME.

Вариант канонического имени: **apex** (`https://palitra-love.ru`), `www` → редирект 301 на apex. Причина: короче в рекламе, совпадает с тем, как домен указан у клиента.

```caddyfile
# --- Palitra Love: магазин цветов и воздушных шаров -------------------------
www.palitra-love.ru {
  redir https://palitra-love.ru{uri} 301
}

palitra-love.ru {
  root * /srv/sites/palitra-love
  @company_links {
    path /api/company-links
    method GET
  }
  handle @company_links {
    rewrite * /public-company-links/palitra
    reverse_proxy content:8080
  }
  @palitra_price {
    path /api/price /content/palitra/price
    method GET
  }
  handle @palitra_price {
    rewrite * /public-content/palitra/price
    reverse_proxy content:8080
  }
  @palitra_assets {
    path /api/assets/*
    method GET
  }
  handle @palitra_assets {
    uri replace /api/assets/ /content/palitra/assets/
    reverse_proxy content:8080
  }
  @orders {
    path /api/orders
    method POST
  }
  handle @orders {
    rewrite * /public-orders/palitra
    reverse_proxy content:8080
  }
  # Основной домен индексируется: без import draft.
  handle {
    try_files {path} {path}/index.html /index.html
    import static
  }
}

# Старый адрес — редирект только после успешной проверки нового домена (раздел 5).
palitra-love.synapsebusiness.ru {
  redir https://palitra-love.ru{uri} 301
}
```

Порядок применения — два отдельных шага, два PR:

1. **Шаг A** (сразу после DNS): добавить блоки `palitra-love.ru` и `www.palitra-love.ru`; блок `palitra-love.synapsebusiness.ru` оставить как есть (черновик с `noindex`). Сайт доступен по обоим адресам, проверки раздела 5.
2. **Шаг B** (после успешных проверок): заменить старый блок на редирект, обновить `SITE_URL` и все абсолютные ссылки на сайте (раздел 6).

Сопутствующее в сервисе контента: список разрешённых Origin для `/public-orders/palitra` берётся из переменной `PALITRA_ORDER_ORIGINS` (через запятую), по умолчанию только `https://palitra-love.synapsebusiness.ru` (`ops/content/server.js`, константа `ORDER_SITES`). Сейчас `docker-compose.yml` эту переменную в контейнер `content` **не передаёт**. В шаг A тем же PR добавить в окружение сервиса `content` строку `PALITRA_ORDER_ORIGINS: ${PALITRA_ORDER_ORIGINS:-}` и в серверный `.env` значение `PALITRA_ORDER_ORIGINS=https://palitra-love.synapsebusiness.ru,https://palitra-love.ru` (пока оба адреса живы; после шага B оставить только новый). Без этого заявки с нового домена получат 403 по проверке Origin. Значение `.env` вписывается на сервере вручную владельцем/оператором — секретов в нём нет, но файл `.env` из репозитория не управляется.

## 5. Проверки после DNS и шага A (все должны пройти)

```text
nslookup palitra-love.ru 8.8.8.8            → 72.56.249.147
nslookup www.palitra-love.ru 8.8.8.8        → 72.56.249.147
curl -I http://palitra-love.ru/             → 308/301 на https://palitra-love.ru/
curl -I https://www.palitra-love.ru/        → 301 на https://palitra-love.ru/
curl -I https://palitra-love.ru/            → 200, валидный сертификат Let's Encrypt
curl -I https://palitra-love.ru/price.html  → 200
curl -s https://palitra-love.ru/api/price   → 200, JSON с categories
curl -I https://palitra-love.ru/api/assets/<id известного фото> → 200 image/*
POST https://palitra-love.ru/api/orders с Origin https://palitra-love.ru и служебной пометкой → 201
редирект-цепочка без петель: http://www → https://www → https://apex (максимум два перехода)
```

Плюс ручная проверка в браузере: главная, прайс, каталог, карточка, корзина, форма заявки, инфостраницы; картинки грузятся с нового домена.

## 6. Шаг B — после успешных проверок

- `sites/palitra-love/config.js`: `SITE_URL: "https://palitra-love.ru"`.
- `robots.txt`: строка `Sitemap:` на новый домен; `sitemap.xml`, `canonical`, `og:url` на всех страницах (сейчас везде `palitra-love.synapsebusiness.ru`, около 25 файлов — заменить единым проходом и проверить тестом `sites/site-seo.test.cjs`).
- Старый блок Caddy → редирект 301 на новый домен (`import draft` при этом исчезает вместе с блоком, `noindex` для нового домена не ставится).
- Подтверждённый адрес сайта компании в CRM обновить в рамках этого же подключения; чужие компании не трогать.
- Никаких обещаний по поисковым позициям.

## 7. Что делать, если доступ к DNS не появится

Сайт продолжает работать на `palitra-love.synapsebusiness.ru` (с `noindex`, как черновик). Ничего из разделов 3–6 не применять частично: половинчатое состояние (домен на сервере, DNS на чужом адресе) даёт ошибки сертификатов и недоступный сайт.
