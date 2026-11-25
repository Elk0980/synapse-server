# ТайСабай · выпуск черновика сайта v4 на taisabai-draft-1.synapsebusiness.ru

Задача №329. Решение Влада 25.11.2026 23:31: «ссылки с сайтов на боевом нужны».
Источник — артефакт черновика v4 от 25.11.2026 (218 файлов). Здесь лежат его файлы в `payload/`
(217 файлов, около 98 МБ; убраны только превью артефакта и обёртка claude.ai, добавлены
`lang="ru"` и `<meta name="robots" content="noindex, nofollow">`).

## Путь (штатный, как у nebo-draft-1)
Черновики `<проект>-draft-N.synapsebusiness.ru` отдаёт сервис content из `site_workspaces`:
сам ставит `X-Robots-Tag: noindex`, `robots.txt: Disallow: /`, отдаёт видео по Range (206).
Caddy, ключи, права и другие сайты не меняются.

`install.py apply`:
1. `inspect` (только чтение) — черновики ТайСабай, исходник, план. При `STOP` ничего не делает.
2. Бэкап `content.sqlite` → `/data/content-before-taisabai-draft-<время>.sqlite`.
3. Если черновика нет — создаёт его штатной функцией `clone()` (как кнопка «Клонировать» в ЛК).
   Адрес назначает сервер: первый свободный `taisabai-draft-N` (ожидается `-1`). Файлы В2 только читаются.
4. Новая ревизия = ровно файлы `payload/` (проверка SHA256SUMS до и после копирования).
   Прежняя ревизия остаётся на диске.
5. `verify` — живые адреса (см. ниже). Повторный `apply` с тем же пакетом ничего не меняет.

Откат: `python3 install.py rollback` — вернуть прежнюю ревизию; если черновик создан этим
выпуском — скрыть его (`is_active=0`), файлы и записи остаются.

## Команда для Codex (оператор №281), консоль Timeweb synapse-core, root — одна строка
```
cd /tmp && git clone --depth 1 -b claude/taisabai-site-20261126 https://github.com/Elk0980/synapse-server ts-site-20261126 && python3 ts-site-20261126/ops/content/taisabai-draft-20261126/install.py apply
```
Если каталог `/tmp/ts-site-20261126` уже есть (повтор), запустить только вторую часть:
`python3 /tmp/ts-site-20261126/ops/content/taisabai-draft-20261126/install.py apply`.

Готово — в конце `VERIFY_OK https://taisabai-draft-1.synapsebusiness.ru/`.
Сбой: `PRECHECK_STOP …` — ничего не изменено, прислать вывод в №329; `RELEASE_APPLY_FAILED` /
`VERIFY_FAILED` — прислать вывод, при необходимости `install.py rollback`.

## Что проверить после выпуска
- `curl -sI https://taisabai-draft-1.synapsebusiness.ru/` → 200, `X-Robots-Tag: noindex, nofollow`.
- `curl -s https://taisabai-draft-1.synapsebusiness.ru/robots.txt` → `Disallow: /`.
- `curl -s -o /dev/null -w '%{http_code}' -H 'Range: bytes=0-1023' https://taisabai-draft-1.synapsebusiness.ru/v/hero.mp4` → 206
  (так же `views/pool.mp4`, `v/GK-61.mp4`, `r/final-01-depozit.mp4`); `flats.json`, `img/inna.jpg` → 200.
- `https://taisabai.synapsebusiness.ru/` → 200, содержимое не изменилось (verify сверяет SHA до/после).
- Браузер, 1440 и 390: нет горизонтальной прокрутки, консоль пустая, первый экран и виды играют,
  карточка квартиры открывается с видео, квиз доходит до подборки.

## Ограничения (честно)
- Заявки: сервер черновиков запрещает POST (`Это черновик. Отправка заявок отключена`), поэтому
  форма → CRM Synapse на черновом адресе невозможна без изменения кода content. Сейчас каждая кнопка
  собирает текст с номером заявки TS-xxxx и открывает директ Instagram, как в артефакте. CRM — после
  переезда на боевой адрес (маршрут `/api/leads` → crm, как у avokado38.ru) отдельной задачей.
- Медиа отдаются с `Cache-Control: no-store` (так устроен сервер черновиков) — на боевом адресе включить кэш.
- Проверено локально на эмуляции: настоящие `site-workspaces.js` (ветка nebo324) и
  `site-workspace-http.js` (снимок боевого 05.11) с их CSP. Живой адрес проверяет Codex после выпуска.
