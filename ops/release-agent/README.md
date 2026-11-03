# №55 — выпускающий агент, PR481

Кандидат после ревью Claude222. На production НЕ установлен; сервер478/477,
legacy-sync, клиентские данные, ключи и уведомления эта работа не меняет.

## Поведение после ревью

1. `cursor` — последний обработанный main-коммит; `current` — реально работающий.
   Build failure, прерванный prepared и успешный rollback продвигают только cursor.
   Исправляющий PR после них собирается из нового полного дерева. Настоящий
   rollback_failed остаётся аварией: продолжать поверх неизвестного runtime нельзя.
2. Внутри контекста любого сервиса всё, кроме тестов и README*/CHANGELOG*,
   требует runtime-выпуска. В том числе ops/content/skills/**/SKILL.md и рабочие
   Markdown-инструкции: они копируются в образ и читаются Хью. Правило *.md «без
   выпуска» действует только ВНЕ сервисов; там остаются docs/**, specs/**,
   AI_HANDOFF/**, Markdown и тесты. sites/** всегда отдельный publisher57.
   Любой неизвестный путь (compose, Caddy, .github, новый сервис) блокирует ВЕСЬ
   коммит: «ручное применение: <пути>», cursor/current не меняются.

   Штатное продолжение после ручного применения: Влад или Claude-оркестратор
   пишет в задаче выпуска ровно `ПРИМЕНЕНО ВРУЧНУЮ <полный заблокированный sha>`.
   Используется тот же проверенный identity/registry/credential путь, что для
   «КОД ПРИНЯТ»; свободная строка author не даёт разрешения. Сверяются SHA, первый
   parent, задача и изменённые manual-пути. До готовности №68 — fail-closed.
   После подтверждения агент сохраняет подписанную квитанцию, двигает только
   cursor, пишет «Принято вручную» и снимает свой blocker. current runtime SHA
   не выдумывается. Подтверждённые неизменённые manual-пути не блокируют следующий
   runtime PR повторно; новая правка такого пути требует нового подтверждения.
   Квитанции сохраняются и при последующем откате образов.
3. Проверяются зелёные checks exact PR head, вошедшего в merge, и отдельно
   process-check/spec-kit на merge SHA. Выбран этот вариант: существующие workflows
   запускают сервисные проверки на PR, а на main гарантирован только Spec Kit.
   Новая попытка check supersedes старую по app/name/id; required checks должны
   иметь именно success. Список requiredChecks задаётся принятым приватным конфигом.
4. Сборка через `docker compose build <только выбранные сервисы>` сохраняет context,
   dockerfile, args и target принятого build recipe. Context переносится в отдельное
   дерево exact SHA. Контейнеры используют immutable image ID, окружение/mounts
   из полного фактического managed recipe. Нет общего compose up/build или reset.
5. До stop/build/switch записывается fsync-журнал. SQLite VACUUM INTO/integrity/FK.
   Снимки НЕ удаляются агентом: срок хранения минимум7 дней, по умолчанию бессрочно.
6. При миграции и health failure ДО возврата трафика снимок восстанавливается
   автоматически, только если реальный root gate подтвердил закрытие и все writers
   остановлены. Старые DB/WAL/SHM сохраняются в приватной area перед восстановлением.
   Без доказанного gate startup считается возвратом трафика ещё ДО up: новые данные
   никогда не заменяются старым снимком. Поздний сбой откатывает images и сохраняет
   blocker «ждёт Влада: восстановить БД из сохранённого снимка?» с SHA area.
   **В этом пакете нет реализации trafficGate. Без него при сбое миграции всегда
   «ждёт Влада»; автоматического восстановления БД нет.** Gate должен быть отдельно
   принят и подключён до обещания предтрафикового автоматического восстановления.
   Отчёт различает откат образов с текущими данными и восстановление БД из снимка.
7. Outbox хранит несколько событий, повторяет с exponential backoff. Ошибка доски
   не выбрасывается в выпуск. Отчёты используют revision CAS и readback; нет слепого
   повтора комментария. На проход ограничено число попыток. Cached signed admission
   позволяет выпуск при недоступной доске; отсутствие самой доказанной приёмки
   по-прежнему безопасно ждёт, а не выдаёт разрешение без источника. Waiting теперь
   сохраняется в state/outbox и доставляется на доску; поздний отчёт ожидания
   помечается superseded, когда уже есть итоговая квитанция того же SHA.

## Права

Worker `synapse-release` без login, root, sudoers и docker group. Код в
/opt/synapse-release-agent только чтение, /opt/synapse только чтение, кроме доступа
к существующему inode общей flock. Собственный журнал/mirror в /var/lib/synapse-release-agent.

Локальный socket-activated root broker — граница привилегий, а не root worker.
Он принимает фиксированные typed операции для root-config allowlist сервисов.
Нет shell/произвольных argv/compose paths/mounts/DB paths от вызывающего.
Сервисы/parent/SHA/PR/head/task/migration/recipe digest закреплены подписанным receipt.
Предыдущий recipe берётся из root-owned capture, не из запроса worker. Подписывающий
локальный ключ root-only; существующие внешние ключи не меняются. Runtime операции
по умолчанию недоступны без receipt. Gate — отдельно принятый root-owned executable
с командами close/open; без него восстановление БД запрещено. Сам broker не даёт
агенту право на другие сервисы. Изоляция Docker daemon — его штатная root граница.

## Издатель admission и зависимость №68 (блокер229)

`issuer.py` находит merged PR и связанную ссылкой задачу, читает комментарий
«КОД ПРИНЯТ», содержащий exact PR head SHA, и agents registry. Принимается только
серверный identity stamp {verified:true, agentId, credentialId}, где kind=claude,
а credential соответствует root-owned reviewerCredentials. Строка author не используется
как удостоверение. Принятый receipt кэшируется; root key не передаётся worker.
Необратимая миграция требует authenticated owner «ОТВЕТ: да» с exact merge SHA;
до него выставляется blocker «ждёт Влада».

Зависимость на доске — **№68 «серверная метка личности на комментариях»**, дочерняя
задача55, исполнитель «Codex — Сторож доски», проверяющийClaude. Она является
обязательной частью готовности55; создание задачи не закрывает блокер229.

Проверен принятый PR485 exact c36ea45b61ddd3bd8179075fa937b31162829050.
Он уже даёт HMAC-проверку кабинета, agentId MCP ключа и повторную проверку grant
в task-principal.js. watchdog.comment атомарно записывает task_watchdog_comment_auth
(comment_id/task_id/principal/kind/created_at), защищённую immutable triggers.
Этот механизм нужно переиспользовать. Однако task_get.comments и ответ task_comment
по-прежнему выбирают только id/task_id/author/text/created_at. Поэтому PR485
закрывает установление личности/хранение, но **не доставку stamp в issuer55**.

№68 должна экспортировать stamp из этой серверной таблицы с привязкой comment/task
и согласовать identity DTO с issuer, включая Claude agent principal и Влад person
для «ОТВЕТ: да». Не добавлять второй механизм подписи, не восстанавливать legacy
identity из author/kind, не отдавать ключи. Пока экспорта и потребления нет,
WAITS_AUTHENTICATED_CLAUDE_COMMENT — ожидаемый безопасный результат; issuer не готов
к боевому запуску. Общие CRM/MCP файлы и PR485 этим PR481 не изменяются.

## Откат без повторной установки

CLI того же пользователя, с CAS текущего SHA и durable request-id:

```sh
python3 /opt/synapse-release-agent/agent.py --config /etc/synapse/release-agent/accepted-config.json --rollback --expected-sha <текущий40hex> --request-id <уникальный-id>
```

Повтор завершённого request возвращает прежний результат, чужой SHA отклоняется,
неизвестный результат требует readback. CLI сохраняет новые данные. Для кнопки26
нужен серверный ACL owner/Claude+CSRF и вызов этого фиксированного контракта после
аутентификации. Общий router/board26 не изменены; кнопка пока не подключена.

## Одна команда установки после приёмки

`bootstrap.py --commit <принятый40hex> --bundle <root-owned accepted-bundle.json>`
полностью скачивает пакет из immutable SHA, затем ставит units и включает socket
и таймер. `install.py --root <копия>` остаётся безопасной стадией теста. Активация
проверяет acceptedByClaude/reconciled/initialSha; эти поля — утверждения из принятого
root-owned baseline, их нельзя выставлять на основании наличия файла. Сам агент
не очищает checkout372 и не придумывает initialSha. Конкретная строка с immutable SHA
передаётся после публикации коммита, исполнять до приёмки нельзя.

Приватный bundle: worker и broker конфиги, initialSha, acceptedByClaude/reconciled.
Фиксированные пути: worker state/mirror /var/lib/synapse-release-agent[/mirror],
broker state/admissions/runtime.json /var/lib/synapse-release-broker,
key /etc/synapse/release-agent/admission.key, socket /run/synapse-release/broker.sock.
Broker config также задаёт baseline, полный recipe/buildRecipe, DB paths, health,
repository, reviewerCredentials, requiredChecks и существующий boardUrlFile.
Worker config содержит только metadata/config для исходящих запросов, root key не получает.
Рецепты, credentials, manifests и bundle не входят в git. Installer копирует прежний
report URL с группой только worker, не ротирует существующий ключ. Локальный HMAC
для receipts создаётся один раз и не является новым доступом к внешнему сервису.

## Проверка и остаток

`python -m unittest discover -s ops/release-agent -v` + LinuxCI. Docker copy проверяет
плохой image→health failure→image rollback и старую/новую SQLite, custom Dockerfile,
build args/target. Отдельный CI запускает настоящий uid nobody против локального
broker: разрешён typed verify, запрещён shell, root key не читается. Bootstrap/install
tестируются на копии; внешние useradd/systemctl в copy-test записываются mock runner,
поэтому это не доказательство запуска настоящего production systemd.

Остаётся: экспорт существующего principal в comment identity (№68/229), ACL/UI26, production372 baseline,
отдельный site publisher57, actual same-host copy/установка и приёмка≤5мин.
Старые и новые данные/сеансы/URL должны проверяться после разрешённой установки.
Никаких connected/accepted55 до этой проверки.
