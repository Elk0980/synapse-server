# Доказательства

Время проверки: 2026-10-06, около 14:25 по Бангкоку. Проверки выполнил автор — это не независимая проверка. Среда: облачная копия Linux, Node v22.22.2, `node:sqlite`, jsdom 26 (временная установка вне result). На Windows-машине тесты не запускались: командной строки на устройстве в этой сессии нет.

Ниже статус — реализовано и проверено локально на mock. Не интегрировано, не развёрнуто, не LIVE.

## Вход

- Пакет `input/specs/092-vk-events/packet.json`: processVersion 1.0.0, feature `specs/092-vk-events`, deliveryStatus `not_sent`. Включает AGENTS.md, `spec-kit-policy`, конституцию, `spec`, `plan`, `tasks`.
- Пакет прочитан целиком; `input/manifest.json` — 24 файла, sha256 совпали все (0 расхождений).
- Ранее файлы отсутствовали по исходным путям: D:/… и worktree вне подключённых папок, запросы доступа отклонены. Обходов не было.

## Официальные источники (06.10.2026)

- **dev.vk.ru/ru/api/bots-long-poll/getting-started.** `groups.getLongPollServer`; `{server}?act=a_check&key&ts&wait=25`, максимум 90; `failed:1` — новый `ts`; `failed:2` — новый `key`; `failed:3` — новые `key` и `ts`.
- **dev.vk.ru/ru/api/callback/getting-started.** Ответ `ok` и HTTP 200; поле `secret`; подтверждение типа `confirmation`; повторы через 10 с, 3, 10, 30 мин и 1 ч; до 10 серверов.
- **dev.vk.ru/ru/api/community-events/json-schema.** 56 типов событий.
- **VKCOM schema 5.199.** `groups.getLongPollServer`/`getLongPollSettings` — токен user или group; `groups_long_poll_server` — `{key, server(uri), ts}`; `groups_long_poll_events` — 50 типов.
- **UNKNOWN:**
  - включает ли ВК `secret` в запрос подтверждения;
  - бывают ли иные хосты Long Poll, кроме lp.vk.com и lp.vk.ru;
  - точное право ключа сообщества для `groups.getLongPollServer`;
  - включены ли «расширенные товары» у Palitra.

## Команды и фактические результаты

```
node --test ops/crm/vk-events.test.js ops/crm/vk-events-http.test.js sites/synapse/cabinet/vk-events.test.cjs
# tests 20  pass 20  fail 0
node --check (все .js/.cjs result)                 -> ok
git apply --check docs/vk-events-integration.patch (git-репозиторий из input-копий трёх общих файлов) -> ok;
  после git apply файлы побайтно совпали с ожидаемыми; diff --stat: 3 files, +34 −6 (crm +9/−1, content +19/−1, vk-community +6/−4)
jsdom: пропатченный vk-community.js + vk-events.js -> панель смонтирована внутри раздела ВК,
  2 запроса /content/crm/vk-events/*, controls() раздела сообщений не включает кнопки событий; не-owner -> пусто
```

## Покрытие приёмки spec092

- **Неверный секрет или группа, отсутствующий секрет, чужой endpoint, размер, некорректный JSON** — test 3 и HTTP test 3.
- **Durable failure:** при сбое хранения 503 `retry`, `ok` нет; повтор ВК записывает один раз — test 4. Сбой хранения в Long Poll не двигает курсор — test 8.
- **Дубли обоих транспортов в обоих порядках** — test 6, маска 3, `duplicate_count` 1.
- **Курсор после сбоя и перезапуска** — test 8: сохранённый `ts` с новым `key`.
- **`failed` 1/2/3** — test 7: точная последовательность пар `key`/`ts`, пропуски = 2.
- **Конкурентный запуск** — test 6: один `getLongPollServer`. Аренда другим процессом — test 9: `LEASE_HELD`.
- **Смена ревизии во время запроса** — test 9: пачка не записана. **Отзыв** — test 11: ключ удалён, сессия остановлена, старый Callback-адрес отвечает 404.
- **Изоляция компаний** — test 1: шифротекст не переносится; test 12: одинаковый `event_id` в двух компаниях.
- **Приватность:** функция `safe()` проверяет каждый DTO на отсутствие ключа, секрета, строки подтверждения, ключа Long Poll, текста события и `encrypted_`. DOM: поля паролей очищаются, журнал выводится как текст, XSS-строка не превращается в HTML.
- **Только чтение у ВК** — test 5: при проверке вызываются ровно три метода `groups.*`. **Нет произвольного прокси** — HTTP test 1: 405.
- **SSRF Long Poll** — test 10: http, похожий домен, userinfo, порт, query, 169.254.x отклонены.

## Мутационная проверка (отдельная копия, не в result)

**Серверные мутации:**

| Мутация | Упавших тестов |
|---|---|
| нет дедупликации | 2 |
| нет проверки группы в Long Poll | 1 |
| нет проверки секрета Callback | 2 |
| `failed:2` обработан как `failed:3` | 1 |
| `ok` при сбое хранения | 1 |
| любой хост Long Poll | 1 |
| курсор до записи | 1 |
| нет ревизионной проверки внутри транзакции Long Poll | 0 — эквивалентна |

Последняя мутация эквивалентна: ту же смену ревизии синхронно ранее ловит `alive()`/`renew()`, внутренняя проверка — запасная.

**Мутации интерфейса:**

| Мутация | Упавших тестов |
|---|---|
| `innerHTML` в журнале | 1 |
| нет очистки секретов | 1 |
| отзыв одним нажатием | 1 |
| нет защиты от устаревших ответов (epoch) | 1 — после усиления теста возвратом в ту же компанию |

## Полный diff (все файлы result новые; общие файлы только через patch)

sha256 файлов result:

```
be34d9eb… docs/vk-events-integration.patch
5d1a3c23… docs/vk-events.md
a85c98a1… ops/crm/vk-events-http.js
71dd7fa5… ops/crm/vk-events-http.test.js
94cae995… ops/crm/vk-events.js
8552d0bd… ops/crm/vk-events.test.js
ede65eb7… sites/synapse/cabinet/vk-events.css
cede85c1… sites/synapse/cabinet/vk-events.js
2c5d260c… sites/synapse/cabinet/vk-events.test.cjs
8eaada2e… specs/092-vk-events/spec.md  (без изменений, копия входа)
```

Удаления в patch — 6 строк. Все они — заменяемые строки:
- импорт и `Promise.all` в `server.js` CRM;
- regex owner-only в content proxy;
- три строки `vk-community.js`: `let`, разметка, `update`, условие `controls`.

Чужие функции не удалены.

## Не сделано и почему

- **Не входит в patch.** `cabinet.html` (подключение `vk-events.js`/`.css`) и маршрут Caddy `/public-vk-callback/*` → content: этих файлов нет во входной копии, их добавляет Codex.
- **Существующие тесты.** `vk-community.test.js` и `vk-tools*.test` не запускались: они требуют модулей `vk-design`/`vk-materials`/`vk-avatar`, которых нет во входе.
- **Ограничение частоты CRM** (`takeRateLimit`) применяется и к Callback. Content передаёт `x-forwarded-for` исходного запроса. Достаточность лимита при пиках событий — UNKNOWN.
- **Живая доставка, подтверждение Callback и запуск Long Poll** — только после deploy и личного ввода секретов Владом. Секретные значения автору не передавались и не сохранялись.

## Исправления по ревью Codex (06.10.2026)

Ревью Codex на Windows (Node 24): 15 backend- и HTTP-тестов прошли. До интеграции исправлены три случая. Изменены только `ops/crm/vk-events.js`, `ops/crm/vk-events.test.js` и `docs/vk-events.md`; общие файлы и patch не менялись.

1. **Один потребитель на сообщество.** Новая таблица `vk_events_lp_leases` с ключом `group_id`.
   - Аренда группы и аренда строки привязки берутся атомарно (`BEGIN IMMEDIATE`) и вместе продлеваются.
   - Две компании с одним `group_id` или два процесса не могут одновременно опрашивать одно сообщество: `LEASE_HELD`.
   - Неудачный старт не оставляет желания запуска. Журнал пишется только в компанию-держателя.
   - Истёкшую аренду упавшего процесса можно перехватить.
2. **Явная остановка сохраняется.** Новое поле `lp_desired` (миграция `ADD COLUMN`, по умолчанию 0).
   - «start» ставит 1; «stop», сохранение настроек и отзыв ставят 0. «stop» записывает 0 до остановки сессии.
   - `resume()` требует `lp_desired=1`, а `close()` его не меняет.
   - Остановка из другого процесса прекращает потребителя при следующем продлении аренды, без нового `getLongPollServer` и без записи.
3. **Удаление компании.** Продление аренды требует `is_deleted=0`, транзакция пачки перепроверяет компанию.
   - Удаление во время запроса останавливает потребителя.
   - Ни пачка событий, ни `failed:1` не сдвигают курсор, аренда освобождается.
   - `resume()` и Callback удалённую компанию не обслуживают.

## Команды и результаты после исправлений

```
node --test ops/crm/vk-events.test.js ops/crm/vk-events-http.test.js sites/synapse/cabinet/vk-events.test.cjs
# tests 24  pass 24  fail 0   (backend 16, HTTP 3, DOM 5)
git apply --check docs/vk-events-integration.patch -> ok (patch не менялся)
```

Новые тесты:
- **review 1** — группа, две компании, второй процесс, раздельные журналы, перехват истёкшей аренды;
- **review 2** — stop → close → resume остаётся остановленным, явный start, падение без stop восстанавливается, остановка из другого процесса;
- **review 3** — удаление компании во время запроса при пачке событий;
- **review 3b** — удаление компании при `failed:1`.

Мутационная проверка исправлений:

| Мутация | Упавших тестов |
|---|---|
| `acquire` без аренды группы | 1 |
| `resume` без `lp_desired` | 2 |
| `stop` без записи `lp_desired=0` | 1 |
| `renew` без `lp_desired` | 1 |
| `renew` без проверки удалённой компании | 1 |
| `release` без удаления аренды группы | 4 |
| проверки `liveCompany` и `lp_desired` внутри транзакции пачки | 0 — эквивалентна |

Последняя мутация эквивалентна: синхронно перед пачкой `alive()`/`renew()` уже проверяет то же самое, внутренние проверки — запасные.

Статус: реализовано и проверено локально на mock. Не интегрировано, не развёрнуто, не LIVE.

## Независимая проверка и интеграция Codex06.10.2026
- Windows Node24.18.1: окончательные backend/HTTP/DOM тесты spec092 —24/24 passed. Первичная версия20/20 не принята до устранения трёх замечаний; окончательные тесты покрывают group lease, persistent stop и удаление компании.
- Интеграция content/CRM: новый vk-events-proxy.test.js и существующие vk-community-proxy, vk-tools-proxy, vk-community DOM, vk-tools DOM —58/58 passed. Новый тест проверяет отсутствие cookies/identity/CSRF в публичном Callback proxy, owner/company/CSRF приватных настроек, точный endpoint/method, ограничение256KiB и закрытие внутреннего callback через кабинетный proxy.
- Добавлены кабинетные assets до vk-community и новая версия ресурсов; Caddy exact POST /public-vk-callback/<32 base64url> → content. Остальные домены/маршруты не изменены.
- Проверки синтаксиса трёх изменённых JS интеграции, git diff --check —passed. Spec Kit gate check —48 files verified.
- Convergence: проверены6 FR, требования приёмки, решения storage/transports/integration и5 принципов конституции. Добавлены2 remaining partial tasks: штатная проверка Caddy и live-приёмка после снятия deployment block. Нельзя объявлять full convergence/LIVE.
- Caddy/docker на Windows отсутствуют, проверка валидатором не выполнена. Фактический перенос на сервер не выполнен; прежний CRCSTOP и владелец ресурса требуют разрешения без обхода.
- Фотографии, каталог/редактирование цен и публикации не входят в модуль событий и не объявлены подключёнными.
Предложенный integration patch применён и хранится в исходном result исполнителя; в PR входят итоговые изменения файлов. Сгенерированный patch не включён в репозиторий, чтобы не хранить дублирующий diff с контекстными пробелами.
