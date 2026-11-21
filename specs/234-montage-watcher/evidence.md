# Проверки №285

Состояние: код и локальные проверки; выпуск и живая передача монтажёру не подтверждены.

- `node --test ops/montage-watcher/*.test.js ops/content/reel-problems-proxy.test.js ops/content/reel-materials-chat.test.js ops/hugh-runtime/limits.test.js ops/hugh-runtime/job-store.test.js ops/local-hugh/outbox.test.js`: 50/50. Новые тесты: 19, включая настоящий CRM и точную воспроизводимость bundle. Существующие контракты Hugh/outbox не изменены.
- Проверены: два GET без модели на пустой очереди; один dispatch для redo+EDL; атомарный постоянный ключ, рестарт/две копии; старые просьбы, порог10мин, неизвестные reply/dispatch, повтор sourceRef после потери ответа; границы компаний; самая дешёвая доступная настроенная модель; safe logger и отсутствие текстов/ключей в SQLite-журнале; graceful stop/health. Настоящий CRM подтвердил reply в карточке, задачу для Claude и 404 для чужой компании без поддельной личности Owner.
- `node ops/montage-watcher/build-content-bundle.js --check`: байты совпали. Синтаксис bundle/server.js OK. Обёртка ops/content/montage-watcher.test.js включает весь новый набор в существующий project-chat-check CI.
- Gate: 48 официальных файлов OK; отрицательные тесты5/5. `git diff --check` OK.

## Converge
FR-001–007 реализованы в коде. Обязательная связка с production — всего два runtime-файла content, обычный prpatch/prgo без нового compose/service/runtime/бюджета. Тексты переписки и ключи не записываются ни в stdout, ни в SQLite координации; сохраняются только метаданные, фаза и hash ответа.

Открыты внешние этапы: ревью Claude/CI; получить подтверждённый программный вход фактического монтажёра (вопрос285/1943, в checkout его нет); передача production-ресурса и адресный выпуск после286; проверить poll, ноль вызовов на пустой очереди и новую версию от реального монтажёра. Отсутствие входа честно эскалируется и не считается выполненным монтажом. Эти этапы остаются в tasks.md.
