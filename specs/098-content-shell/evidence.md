# Свидетельства 098 (а) · каркас

05.11.2026, Linux, ветка claude/night98-a-shell от origin/main b2fb672. Время — Бангкок.

## Живая копия cabinet.html
- Живой файл отличается от main (sites-projects.css, «Формы проектов», «Клонировать сайт»).
- Патч `cabinet-html.patch` = `git diff origin/main -- sites/synapse/cabinet.html`.
- `patch --dry-run -p3 live_cabinet.html < cabinet-html.patch`: rc=0, 19/19 hunks succeeded, fuzz 0, FAILED 0
  (вывод: `cabinet-html.dryrun.txt`). Первая версия давала 3 конфликта: меню, cabinetAssets, permittedView.
  Их переделал в точечные вставки: «Хью» → «Чаты» и порядок меню делает скрипт, ассеты подключаются отдельными списками shellAssets/shellStyles.
- Снимки живой копии с наложенным патчем и файлами (а)+(б): 6 экранов × 2 ширины = 12, горизонтальная прокрутка 0,
  ошибок страницы 0; меню: Главная, Контент, Формы проектов (только владелец), Задачи, Чаты, Настройки.

## Playwright, локальная заглушка API (whoami владельца, content-settings по умолчанию, прочее `{}`)
- (а)+(б): 11 экранов × 390/1440 = 22 снимка. scrollWidth == clientWidth на всех (390/1440), ошибок страницы 0.
- Контент-план, Съёмка, Материалы, Подключения: заглушка «Скоро». Постинг (#content-factory/plan) открывает autoposting.
  Статистика до модуля Е — прежняя content-factory-stats. «Чаты» до модуля Д — прежний чат проекта (hugh).
  Настройки → Контент — экран (б).
- Плавающая кнопка чата есть на всех экранах; на 390 px скрыта на экране чата, как задумано.
- Сравнение с main на той же заглушке: home, content-factory/plan, tasks, hugh, content-factory-stats
  открывают те же виды с тем же текстом, ошибок 0, прокрутки нет.

## node --test
- Первый полный прогон (а)+(б) до разделения: 178 файлов (sites/synapse/cabinet, sites/synapse, ops/content).
  Упало 3: autoposting-daily (ReferenceError byId: тест вырезает участок маршрутизации; скрипт меню перенесён
  ниже setCategoryForView, после переноса 54/54), company-links 13/15 и editors 16/17 — так же падают на main.
- Повторный прогон после разделения (head cf34f1a): sites/synapse/cabinet + sites/synapse — 80 файлов, 78 PASS.
  Падают company-links (13/15) и editors (16/17), на main b2fb672 результат тот же.

## ctx.csrfToken и ctx.api.raw (просьба В, комментарий 481)
- jsdom: `api.raw('PATCH', 'shooting-uploads/5', Uint8Array(1024), {headers: offset+octet-stream})` →
  `/content/shooting-uploads/5?companyCode=avokado`, X-CSRF-Token есть, тело 1024 байта; GET идёт без CSRF;
  `ctx.csrfToken` = токен сессии.
- Очередь window.SynapseModulesQueue (jsdom): регистрация до загрузки реестра и push после — обе работают.

Не проверено: рабочая система, выпуск, права Лены/Тани/СММ на живом кабинете.
