# Свежая допоставка интерфейса после фактического R7

Spec: specs/096-palitra-durable-auth-outcome

Это отдельный static/UI контекст, а не новый выпуск backend. Уже работает image53fcc6…bfea26. Старый R7 inspect отказал DIAG_CLOCK_WINDOW; его BASE, prepared, diagnostic journal, receipts и helper473028 остаются неизменными. Старый runtime-accepted.json не создаётся.

Новый receipt kind: FRESH_CURRENT_RUNTIME_FOR_STATIC_ONLY_V1. Закрытая область /opt/synapse/releases/palitra-auth-chat-static-current-20261031-r1. Исходники только /root/palitra-auth-chat-static-current-20261031-r1/{current.py,drift.py,verify.py,companion-pins.json}; доставка по immutable commit и SHA до первого исполнения. Секреты и полные факты БД остаются на сервере.

current.py переиспользует неизменные функции frozen R7: package/source review, strict built-image/fulltree/config/5identity/plan/policy/price, backups, managed337+полную историю, startup с новым nonce и запасом180с. Новая staticBASE хранит ВСЕ текущие факты11путей, новый diagnostic baseline/journal. PREPARE_TTL=900, diagnostic WINDOW=1080000ms и остальные ограничения не меняются. static guard: два полных прохода данных вокруг startup, затем ресурсы и пять конечных identities. Неизменный host_static.py обеспечивает CAS, intent, backup, lateCAS, atomic replace и независимое чтение двух файлов. Неизвестный исход — inspect-only.

Перед новым snapshot узкий исторический classifier обязан подтвердить:

- schema всех БД прежняя плюс четыре exact EMPTY additive таблицы; девять content paths неизменны;
- content: только прежние два диагностических поля с теми же ключами/payload и monotone highwater; одна строка deepseek имеет прежние key/revision/data/status/error, только checked_at/attempt_at с равными свежими временами;
- CRM: одна schedule/partial/closed0 запись запуска и связанное evidence; в одном снимке только collected_at/run_id, очередь ровно одного совпадающего scope с attempts6 удалена по установленному лимиту6; три sequence ровно+1, новые id соответствуют highwater; все остальные schema/PK/cardinalities/старые строки exact;
- observed source hashes background writers совпадают; время запуска после original BASE и до наблюдения. Это классификация исторического конкурентного изменения, не обход старого срока и не доказательство происхождения таймера по одному времени;
- classifier повторяется вокруг текущего snapshot и обязан дать одинаковый результат. Два текущих wholeDB end fences и все5identities затем обязательны.

CLI только prepare / host / shell / inspect. Нет build/up/restart/restore, SQL/application writes, ручного refresh provider и изменения очередей. Новый контекст разрешает лишь исходную пару cabinet native-host+shell. Исходные payload и product code не меняются.

После отдельного успешного inspect static пары verify.py проводит исходную RO managed-проверку337→338, raw before backup,180с permit и полный readback141файла+всех337старых revision trees. Все его функции кроме provenance AST-exact прежнего LF verifier. AFTER=e564f807…793c5e8/81128B; новый источник provenance привязан к явному свежему kind, исходным R7 доказательствам и полной static паре. Сохранение только штатным интерфейсом site-files; verifier сам не сохраняет.

Локальные18PASS/0FAIL/0.857s: закрытая классификация, неизвестные business/schema/provider изменения, scope/time/sequence/highwater, record→fact hashes, отрицательные проверки runtime tree/config/plan/price/5identity/backup/history/startup nonce/двух end fences/TTL/provenance/static pair. Windows fixture I/O подменяет только известную разницу точности stat/fstat ctime; production Linux safe() неизменна. Frozen product139 и старые suites не повторялись. CAS/nonprefix/intent/empty-schema/diagnostic clock/vault freshness используют исходные pinned guard modules, без переписывания.

Нативное исполнение этого companion и клиентская/административная приёмка ещё не выполнены. Соцсети и их настройки не открываются и не изменяются; source-only чтение служебного writer нужно исключительно для объяснения обнаруженного отличия CRM.
