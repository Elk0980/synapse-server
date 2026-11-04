# Яндекс в Synapse: кандидат к подключению

Здесь реализованы переносимые server/ui модули и посадочные Авокадо. Они ещё не смонтированы в рабочий кабинет; реального OAuth, supervisor и рекламного API-транспорта нет. Никаких live-операций этот каталог автоматически не запускает.

- [Сервер: контракты и границы](server/README.md)
- [Интерфейс и адаптер хоста](ui/README.md)
- [Посадочные, исходная основа и выпуск](landing/README.md)
- [Спецификация](../../../specs/20261028-yandex-connector/spec.md)

Проверка из корня репозитория:

```powershell
node --test ops/integrations/yandex/server/integration.test.js ops/integrations/yandex/ui/ui.test.mjs ops/integrations/yandex/ui/bridge.test.mjs ops/integrations/yandex/landing/tests/landing.test.cjs
py -3 -B -m unittest discover -s ops/integrations/yandex/landing/tests -p test_fixture.py
```

При монтаже сначала получить свежую auth/runtime основу, подключить защищённый transport и broker, подтвердить личность OAuth, затем чтение существующих объектов и вторую реальную компанию. Не заменять старый сервер этим модулем и не переносить живые данные в публичные fixtures. Бюджетная политика в кандидате — локальное ограничение предложений, не фактическое управление бюджетом Яндекса.
