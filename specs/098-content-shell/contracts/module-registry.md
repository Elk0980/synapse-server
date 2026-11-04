# Контракт А: реестр модулей ЛК и Настройки → Контент

Версия контракта: 1. Владелец: агент «А · Каркас» (задача №98). Ветка: `claude/night98-a-shell`.
Файлы оболочки: `sites/synapse/cabinet/module-registry.js`, `sites/synapse/cabinet/shell.css`,
`sites/synapse/cabinet.html` (меню, маршруты), `ops/content/content-settings.js` (сервер).

## 1. Регистрация модуля

```js
window.SynapseModules.register('content-shooting', {
  title: 'Съёмка',                 // заголовок экрана, строка
  mount(el, ctx) { ... },          // обязательна; el — пустой <div>, можно вернуть Promise
  unmount(el, ctx) { ... }         // необязательна; снять таймеры/слушатели
});
```

- `id`: `^[a-z][a-z0-9-]{1,47}$`. Повторная регистрация того же id заменяет определение и
  перемонтирует открытый экран. Ошибка в `mount` не роняет кабинет: оболочка показывает
  «Модуль не открылся» и пишет ошибку в консоль.
- Файл модуля подключается одной строкой в списки `cabinetAssets`/`cabinetStyles` в
  `cabinet.html` (единственная разрешённая точечная вставка в общий файл).
- Пока модуль не зарегистрирован, на его месте заглушка «Скоро» без падений.
- `mount` вызывается при каждом входе на экран и при смене компании (перед этим `unmount`).
  Содержимое `el` после `unmount` оболочка очищает сама.

## 2. Маршруты и id модулей

| Пункт меню | Адрес | id модуля | Агент | Пока не зарегистрирован |
|---|---|---|---|---|
| Контент → Контент-план | `#content/plan` | `content-plan` | Б | «Скоро» + ссылка на «Предложения плана» |
| Контент → Съёмка | `#content/shooting` | `content-shooting` | В | «Скоро» + «Исходники» |
| Контент → Материалы | `#content/materials` | `content-materials` | Г | «Скоро» + «Исходники» |
| Контент → Постинг | `#content-factory/plan` | (существующий экран автопостинга) | Г | работает как раньше |
| Контент → Подключения | `#content/connections` | `content-connections` | Е | «Скоро» + «Соцсети» |
| Контент → Статистика | `#content/stats` | `content-stats` | Е | прежняя «Статистика контента» |
| Чаты | `#chats` | `chats` | Д | прежний чат проекта (`#hugh`) |
| Задачи | `#tasks` | (существующий экран) | Д | как раньше |
| Настройки → Контент | `#settings/content` | (оболочка А) | А | — |
| Плавающая кнопка чата | панель справа внизу | `hugh-chat` | Д | «Скоро» + ссылка «Чаты» |

Подпуть доступен модулю: `#content/shooting/12?actor=2` → `ctx.route = {path: '12', params: URLSearchParams}`.
Сменить подпуть внутри модуля: `ctx.navigate('content/shooting/12')`.
Когда зарегистрирован `content-materials`, кнопка «Создать публикацию» на экране «Постинг» скрывается
(она переезжает в «Материалы»).

## 3. Контекст `ctx`

```js
{
  moduleId, companyCode, companyName,
  user: { id, login, name, role },        // role: 'owner' | 'editor'
  permissions: [...],                     // права текущего пользователя
  can(permission) -> boolean,             // владелец — всегда true
  signal,                                 // AbortSignal, прерывается при unmount/смене компании
  route: { path, params },
  api: {                                  // fetch к /content/*, JSON, same-origin
    get(path, params?),                   // companyCode добавляется автоматически
    post(path, body?, params?), put(...), patch(...), del(path, params?)   // CSRF добавляется сам
  },
  crm(path, params?, options?),           // существующий crmQuery (/content/crm/*), scoped по компании
  settings: { content: { get(), save(settings, version) } },  // см. раздел 4
  navigate(route), openHughChat(), escapeHTML(text)
}
```

Пример: `await ctx.api.get('content-settings')` → `GET /content/content-settings?companyCode=<код>`.
Ошибка API — `Error` с `status` и `code` как в остальном кабинете. Права всегда проверяет сервер.

## 4. Настройки → Контент (API для модулей)

`GET /content/content-settings?companyCode=<код>` — любой вошедший пользователь с доступом к компании.

```json
{ "companyCode": "avokado", "version": 3, "updatedAt": "2026-11-05T01:10:00.000Z", "updatedBy": "Влад",
  "canEdit": true,
  "settings": {
    "approverUserIds": [5, 7],
    "shootingWeekdays": [2, 4],
    "deadlineDays": 3,
    "platforms": ["instagram", "telegram", "vk"],
    "caption": { "font": "Montserrat", "size": "m", "color": "#ffffff", "uppercase": false }
  },
  "candidates": [ { "id": 5, "name": "Лена", "role": "editor" } ],
  "options": { "platforms": [...], "fonts": [...], "sizes": ["s","m","l"] } }
```

- `shootingWeekdays`: ISO-дни 1 = понедельник … 7 = воскресенье.
- `deadlineDays`: за сколько дней до выхода рилс должен быть снят и загружен (0–60).
- `approverUserIds`: только из `candidates` — люди компании с правом `content-plan.approve`
  (и владельцы). Пустой список = согласует владелец.
- Без сохранённых настроек `version: 0` и значения по умолчанию (`[]`, `[]`, 2, `[]`, Inter/m/#ffffff).

`PUT /content/content-settings?companyCode=<код>`, заголовок `X-CSRF-Token`, тело
`{ "version": 3, "settings": { ... все пять полей ... } }` — только владелец или пользователь с
`settings.edit` и доступом к компании. Ответ — как GET, `version` + 1. Чужая версия — `409 VERSION_CONFLICT`.
Лишние поля или неизвестная площадка/шрифт — `400`. Чужая компания — `403`.

В браузере: `ctx.settings.content.get()` / `.save(settings, version)`; вне модуля —
`window.SynapseModules.contentSettings(companyCode).get()`.
