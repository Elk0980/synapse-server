# Доказательства и пределы

## Исправления ревью224

Перед записью local/remote/PR483 совпали на a92c657a, gitstatusclean,
log a92c..originbranch пустой: чужих коммитов/правок нет (№57/230).
Пункты1–3: labeled/unlabeled в bootstrap, вся.github/** и всеops/{content,crm}/**
требуют инфраструктурную метку. 17localtests PASS, включая новые workflows/actions,
backend Dockerfile/deps/новый модуль, rename-out и bootstrap event regression.
П.5: MAIN_PROTECTION.md — 3шага по официальной GitHub документации, без изменения
настроек; blocker выставляется после готовностиPR. П.4: ISOLATION_ACCEPTANCE.md
и координация55/comment231; реальные serverwrites/hashmeasurement/rollbacktimer0.
Finalhead CI и автоматический цикл unlabeled→FAIL/labeled→PASS — результат в №57/CURRENT.

## Предыдущее состояние до ревью224

Разведка main fb598368 до записи: №57/comment184, 04.11.2026 Asia/Bangkok.
13 unittest PASS локально: точность меток, каждый клиент, новые и nested draft пути,
shared inputs, rename out/between, deletion, bad paths, stale/closed/partial list,
101-file pagination и снятие метки во время чтения; статусы pending/failure/success
на exact SHA и отказ неверной цели; независимые изменения метаданных репозитория
не дают ложный отказ, смена base SHA всё ещё блокирует. Серверных проверок0.
SpecKit48pins +5tests PASS.
GitHub main/protection404 Branch not protected, rulesets=[]; настройки не изменены.
Принятые текущие manifests неизвестны, вопросClaude184; required check вопрос190.
Новый target workflow в main ещё отсутствует. Bootstrap PR check не заменяет его.
Runtime isolation/hash invariance/rollback≤300с/live sessions не выполнены.
Draft PR483, исходный5e330bd3: Linux10tests PASS, bootstrap run41681563862 attempt1
ожидаемо FAILURE: отсутствует метка «сайты: инфраструктура»; SpecKit41681563503 SUCCESS.
Метка добавлена, rerun attempt2 запущен; на момент записи выполняет checkout.
Финальный exact-head CI и handoff фиксируются после выполнения в №57/CURRENT.
Workflow target пишет только commit status production-sites/path-approval на exacthead;
read-only bootstrap не публикует его. Сам trusted target ещё не подключён к main.
