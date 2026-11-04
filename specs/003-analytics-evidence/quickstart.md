# Повторение проверки

1. `python tools/spec-kit/gate.py check`.
2. Установить jsdom вне проекта и задать NODE_PATH на его node_modules (как существующий CI).
3. `node --test sites/synapse/cabinet/analytics-potential.test.cjs sites/synapse/cabinet/analytics-2gis.test.cjs`.
4. `node --test ops/crm/analytics.test.js ops/crm/studio-journey.test.js ops/crm/studio-commerce.test.js ops/crm/social-stats.test.js`.
5. `python .specify/scripts/python/check_prerequisites.py --json --require-spec --require-tasks --include-tasks`.
6. Прочитать evidence.md и docs/analytics-readiness.md; локальные тесты не являются рабочей сверкой.
