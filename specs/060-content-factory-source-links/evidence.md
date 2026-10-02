# Свидетельства CF10

01.10.2026. Прочитаны AGENT-ECONOMY, local AGENTS, docs/spec-kit-policy.md, constitution и docs/agent-source-integrity.md; версия процесса1.0.0.

Реализованы attachSource/sourceUsage и autoposting_source_links. Приватные createPrepared/updatePrepared сохраняют прежнее поведение обычных методов и позволяют attach использовать одну транзакцию. Квитанция содержит полный первоначальный post/link DTO; retry возвращает её до invalidate. Usage читает текущую карточку, сохраняя прежнюю связь.

## Собственные проверки
- node --test ops/crm/autoposting-source-links.test.js:9/9passed, duration316.536ms. Только memory SQLite, транспорт исключает внешние вызовы.
- node --test ops/crm/autoposting.test.js ops/crm/autoposting-recovery.test.js ops/crm/autoposting-review-batch.test.js ops/crm/autoposting-source-links.test.js:97/97passed, duration2248.8782ms, fail0/skipped0.
- git diff --check -- ops/crm/autoposting.js:exit0.
- python -B tools/spec-kit/gate.py check:status=ok, verifiedFiles48, integrations codex/claude/qwen. Это проверка комплекта процесса, не независимое ревью новой функции.
- Сравнение с сохранённым в памяти непосредственно перед записью исходником: после обратного удаления только собственного CF10 patch содержимое побайтно совпало после нормализации CRLF. Прежние CF4/CF5/batch/уточнения импорта сохранены; посторонних удалений нет.

## Соответствие требованиям
FR1: пробы ID/revision/SHA/public URL/чужой компании/неизвестных полей и ровно одной цели. FR2: создание без расписания/одобрения, append и сброс согласования, company/revision/archive/publishing/published/needs_review guards, лимит10. FR3: искусственный отказ INSERT связи полностью откатывает create/update/историю/согласование. FR4: повтор после ручной замены и пересоздания API, повтор после архивации,409при другой source/target/revision; одна карточка/связь. FR5: свежие заголовок/contentRevision, current после замены, явный архив, отдельные компании и сохранение нескольких связей.

## Граница готовности
Проверено ядро CRM на локальной синтетике. HTTP, CSRF, подлинность source provenance, действительный content export и UI интегрирует/проверяет основной Codex; этим исполнителем они не объявляются готовыми. Общая копия, QA, server.js, sites, manifest/state и прочие файлы не изменялись. Commit/push/deploy/liveAPI не выполнялись.
