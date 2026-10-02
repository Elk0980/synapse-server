# Свидетельства CF29-server

Документы созданы до code. Прочитаны AGENT-ECONOMY, местные AGENTS/docs/spec-kit-policy/.specify/memory/constitution процесса1.0.0 в этой сессии. Владение дано root; baseline social-stats.js B51CA292220899455776A9DCD82FFC9FC3E92AE4B1BAF6E35835AA3ADCD543D6 (принятый CF27).

## Реальные собственные проверки

Среда Node v24.18.1 / Windows. Все БД synthetic in-memory; adapters пустые, никаких исходящих live API, сбора, публикаций или сервисов не запускалось. Документы созданы до нового теста и production-правки; options/error контракт передан root после документов.

1. На baseline CF27 (SHA выше) выполнено:
   `node --test --test-name-pattern="CF29 Moscow" ops/crm/social-stats-project-period.test.js`
   Exit1, tests1/pass0/fail1. Настоящий social-stats с SQLite дал `[leads:2,sales:2,revenue:700]` вместо `[4,4,700]`: локальные start/сентябрьский UTC timestamp исключены, точный локальный end ошибочно включён. Тест проверяет реальные связанные заявки, не только helper или period metadata.
2. После минимального fix:
   `node --test ops/crm/social-stats-project-period.test.js ops/crm/social-stats.test.js ops/crm/social-stats-tags.test.js ops/crm/content-factory-stats-contract.test.js`
   Exit0, **71/71**, fail/cancelled/skipped0. Новый suite6/6, основной50/50, tags10/10, stats-contract5/5. Старый stats-contract по UTC остаётся зелёным без изменения теста.
3. `python -B tools/spec-kit/gate.py check`: exit0, status ok, verifiedFiles48.
4. `python -B .specify/scripts/python/check_prerequisites.py --json --require-spec --require-tasks --include-tasks` с process-local `SPECIFY_FEATURE_DIRECTORY=specs/079-content-factory-project-stat-period` и `SPECIFY_FEATURE_NO_PERSIST=1`: exit0, FEATURE_DIR079, AVAILABLE_DOCS tasks.md. Переменные восстановлены, общий feature state не писался. Extension hooks отсутствуют.

## Проверенные контракты

- Москва October2026: start `2026-09-30T21:00:00.000Z` включён, end `2026-10-31T21:00:00.000Z` исключён. Проверены строки timestamps с/без milliseconds. Сентябрьский UTC `2026-09-30T21:30:00Z` включён в октябрь проекта. Связанные leads/sales/revenue и bySource получают один и тот же диапазон.
- Berlin: весенний день23h, осенний25h; месяцы March743h / October745h. Проверены события непосредственно до/start/end−1ms/end и фактический результат выборки, не только длина периода.
- Companies isolation/active: alpha Moscow и beta UTC с одинаковым адресом и моментом не смешиваются; удалённая alpha404. Options timezone/companyCode не позволяют переопределить stored source (400 с соответствующим field).
- Options строго: отсутствие/{} / explicit utc совместимы; null,array,boolean,string, unknown/case-changed/nonstring/null/undefined-own crmPeriod дают400 VALIDATION_ERROR field crmPeriod. Unknown own key даёт field этого ключа.
- Stored timezone null/empty/whitespace/unknown/nonstring даёт400 field timezone в attribution и overview, fallback нет. Legacy UTC при том же stored timezone работает как раньше.
- Project overview отличается только crm; source timezone Asia/Bangkok и daily views9 сохранены. postMetrics/coverage/лимит200 и aggregate идентичны legacy overview. CF27 tags текущей доказанной версии сохранены, после изменения card content_revision старые receipts дают обе метки null.
- total_changes до/после всех чтений одинаков; публичный UTC DTO без period. Project metadata только attribution.period / overview.crm.period.

## Diff / baseline / границы

Production diff сверён относительно readonly QA social-stats.js с тем же baseline CF27 SHA: небольшой crmRange(options/company timezone/dayBounds), две замены binds CRM диапазона, opted period и передача options через overview. Остальные источники/агрегаты/лимиты/tags не менялись. Новый тест и четыре документа079 — остальные разрешённые записи. Никаких schema migrations или изменений HTTP/UI/прав/серверного wiring.

Converge: проверены5FR,3SC,5tasks,5шагов плана и принципыI–V в выделенной области; открытых требований не найдено, дополнительные задачи не добавлены. SHA6 передаются root после последней записи и whitespace-check. Это собственная проверка исполнителя, не независимая приёмка.

- `ops/crm/social-stats.js`: `A7024D38EE68D4DF8CC87E67DB87CA6133D83C0BF3E87AA7F6E12821C43DC6E1`
- `ops/crm/social-stats-project-period.test.js`: `D037CDF27F2117DF17C506D79C09A5ED596CDB1C8A07E387D10B9413AB9F842F`

HTTP/root080, UI/Claude, QA integration и production/live этим пакетом не выполнялись и не объявляются подключёнными. После окончательных SHA запись остановлена.
