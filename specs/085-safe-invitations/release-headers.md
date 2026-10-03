# Контракт заголовков страницы принятия (к согласованному выпуску; production Caddy не менялся)

Статический HTML/JS/CSS страницы отдаёт Caddy, а не `content`: заголовки JSON-ответов `/content/invitations/*`
(`no-store`, `no-referrer`) страницу не защищают. До выпуска root добавляет в блок `synapse.synapsebusiness.ru`
ровно это (по образцу `@miniapp`), выпуск — только после согласования:

```caddy
  @accept_invitation path /accept-invitation.html /accept-invitation.js /accept-invitation.css
  header @accept_invitation {
    Cache-Control "no-store"
    Referrer-Policy "no-referrer"
    X-Robots-Tag "noindex, nofollow"
    X-Content-Type-Options "nosniff"
    Content-Security-Policy "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
  }
```

Страница совместима с этим CSP: нет встроенных `<script>`/`<style>`/`style=`/`on*=`, все ресурсы — свои относительные
файлы, запросы — `fetch` на свой `/content/invitations/*` (проверяется `sites/synapse/accept-invitation.test.cjs`).

Проверка после выпуска (без приглашения и без секрета; `#…` не уходит на сервер):
```
curl -sSI https://synapse.synapsebusiness.ru/accept-invitation.html
curl -sSI https://synapse.synapsebusiness.ru/accept-invitation.js
curl -sSI https://synapse.synapsebusiness.ru/accept-invitation.css
```
Признак готовности — у всех трёх: `cache-control: no-store`, `referrer-policy: no-referrer`, `x-robots-tag: noindex, nofollow`,
`x-content-type-options: nosniff` и `content-security-policy` ровно как выше; у HTML статус 200 и `content-type: text/html`.
В браузере: страница без фрагмента показывает «Ссылка приглашения неполная…», в консоли нет нарушений CSP, сеть — только свой домен.
Откат — удалить эти строки из Caddyfile.
