# Managed-сайты: долгий кэш версионных медиа /tour-media

Задача: `nebo-draft-1.synapsebusiness.ru` отдаёт `/tour-media/*.mp4|jpg` с `Cache-Control: no-store`,
поэтому браузер заново качает тяжёлые ролики экскурсии при каждом заходе. Имена файлов версионные
(`pk26.mp4`, `n26-img-g2.jpg`, плюс `?v=1`), их можно кэшировать навсегда.

## Кто отдаёт файлы

Публичные адреса `*-draft-N.synapsebusiness.ru` обслуживает content-сервис:
`ops/content/site-workspace-http.js` → `createDraftHostHandler`, строка 101–102 ставит
`'Cache-Control':'no-store'` для любого файла версии сайта; Range/206 — строки 103–109.
Этого файла **нет в main**: он есть только в managed source tree сервера и в снимке
`origin/snapshot/server-live-20261105-v2` (копия — `fixture/`, SHA256 `3f08a192…6aef`).
Блока `*-draft-N` нет и в `caddy/Caddyfile` main.

## Правка

`patch.cjs` по якорю меняет одну строку и добавляет константу `TOUR_MEDIA`:
файлы `tour-media/**.{mp4,webm,jpg,jpeg,png,webp,avif}` получают
`public, max-age=31536000, immutable`, всё остальное (index.html, assets, json, 404/403) — прежний `no-store`.
Проверки хоста, метода, пути (validPath, realpath внутри версии), CSP, noindex и Range/206 не меняются.
Если файл на сервере отличается от якорей, `check` вернёт `anchor-mismatch` (код 1), `apply` откажет.

## Выпуск (Codex, managed-release)

1. `node patch.cjs check <managed source>/content/site-workspace-http.js` — записать SHA256 и `state`.
2. `node patch.cjs apply <файл> <новая копия>` → просмотреть diff (2 строки добавлены, 1 изменена) →
   выпустить штатным managed-release, перезапуск только `content`.
3. Проверка: `curl -sI https://nebo-draft-1.synapsebusiness.ru/tour-media/pk26.mp4?v=1` →
   `cache-control: public, max-age=31536000, immutable`; `curl -sI .../` → `no-store`;
   `curl -s -o /dev/null -w '%{http_code}' -H 'Range: bytes=0-99' .../tour-media/pk26.mp4` → `206`.

## Проверки

`node --test ops/content/nebo-tour-media-cache-20261125/patch.test.cjs`
