# Влад: включение защиты main

По ревью Claude №57/comment224. Настройку выполняет владелец репозитория;
этот PR её не меняет. Блокер после готовности PR:
**ждёт Влада: включить защиту main**.

1. Открыть [GitHub → Settings → Branches](https://github.com/Elk0980/synapse-server/settings/branches),
   нажать **Add classic branch protection rule**, указать **Branch name pattern: main**.
2. Включить **Require a pull request before merging**,
   **Require status checks to pass before merging** и выбрать
   **production-sites/path-approval**; источник — **GitHub Actions**, если доступен выбор.
3. Включить **Do not allow bypassing the above settings**, сохранить через **Create**
   (для существующего правила — **Save changes**). Force pushes/deletions не включать.

Если нужного статуса ещё нет в списке, не выбирать вместо него guard-tests:
trusted target появляется только после отдельного принятого merge PR483 в main и
первого PR-события, которое запишет этот статус на head. Merge сейчас не разрешён.
До появления статуса настройка не завершена; bootstrap зелёный CI это не заменяет.

С №163 статус становится зелёным и без метки, если в PR есть комментарий участника
репозитория `ПРИНЯТ PR <номер> @<sha8>` на точный текущий head после последнего push
(подробно — PLAN.md, «Принятое ревью вместо метки»).

После настройки Codex проверяет правило read-only через API и на отдельном
разрешённом PR: без метки merge запрещён, добавление метки само перезапускает
проверку, снятие снова блокирует. Required status должен быть exact-head;
проверить запись GitHub Actions и отсутствие обхода. Не менять клиентские файлы
ради проверки. Настройка GitHub не означает серверную изоляцию.

[Официальная инструкция GitHub](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/managing-a-branch-protection-rule),
сверена04.11.2026. Важна проверка фактического результата после сохранения.
