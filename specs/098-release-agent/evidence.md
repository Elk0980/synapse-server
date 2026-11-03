# Доказательства и converge

Разведка: main fb598368; task25/comment134 устанавливает предсуществование372
записей на hostHEAD28fbec23, managed runtime/overlays/473/schema9/projectforms.
Поимённая атрибуция всех строк не установлена. Разведка/план —55/168.

Личные Windows проверки на1c584bcb:19tests,17PASS/2SKIP(flock и Docker).
Проверены два последовательных engine выпуска, SQLite old/new data при failure,
backup failure до switch, build failure до stop, каждая crash phase, failed rollback,
stale/manual повтор, SHA/signature/expiry/migration/reconciliation, CI и unknown paths,
unknown board response/readback и отсутствие ложного connected при preflight error.
Inventory не публикует content и сохраняет source/env/rename; installer копия inactive.

LinuxCI исходного91b75975 —41679464801 и41679534158 SUCCESS:
unit/flock, REAL disposable Docker Compose плохой image→health failure→old image,
старая и новая SQLite записи сохранены, backup существует; inert install-copy PASS.
Последующие исправления требуют свежего CI своего head; старый успех не переносится.
Spec Kit обнаружил отсутствующую Spec-строку PR; спецификация дополнена, PR обновлён.

Converge: FR2–4 реализованы как ограниченное транзакционное ядро;
FR5 transport реализован, production не подключён; issuer/rollback UI не реализованы.
FR1 только offline inventory, сервер не читался/не менялся. FR6 соблюдён.
FR7 только inert installer, окончательной команды full bootstrap нет.
Никаких connected/verified/accepted для55 не заявляется. Кандидат остаётся draft.
Ограничения не прячутся за успешным CI; полная готовность№55 отсутствует.
