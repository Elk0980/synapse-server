# Проверки №87

04.11.2026. Реализовано и локально проверено, ревью Claude/выпуск отдельно.
- FR-001/003: people-password.test.js — настоящий loopback content HTTP:
  создание, 72ч/истечение, повторная выдача, 10-символьный личный пароль,
  запрет совпадения/короткого, старые cookie/пароли, owner-only и CSRF.
- FR-002: общий gate; people-tasks.test.js проверяет reset во время чтения,
  запрет изменения статуса даже после reset→self-change; MiniApp проверяет
  старый bearer и новый Telegram initData с обязательной сменой.
- FR-004: WAL-копия, integrity, прежний owner/editor/права/версия, BLOB,
  ошибка backup до DDL и идемпотентность проверены локально.
- FR-005: аудит без пароля/хэша; 25 people DOM/SW тестов, старые редакторы
  и файлы; CUA/IAB фактические 390×843 (scrollWidth=390), форма целиком видна,
  несовпадение и reload проверены на локальном макете, вкладка закрыта.
Итог: node --test people-*, company-team*, content-admin, session-persistence,
crm-permissions, client-price-access, project-chat-miniapp, CRM people/coordination,
people UI и шесть legacy UI suites — 194 PASS/0 FAIL/0 SKIP
(PEOPLE_TEST_REAL_WEB_PUSH=1, transport перехвачен локально, реальной доставки нет).
Spec Kit gate check: 48 файлов PASS; git diff --check PASS.
Converge FR-001–005: требований без реализации не обнаружено; production,
физический iPhone/клавиатура и принятие не заявляются. Доска не менялась.
