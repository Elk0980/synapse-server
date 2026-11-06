# №178 — расширение автовыпуска статических сайтов

FR-1: явные корни cabinet/brand и avokado, avokado2, avokado3, alvi, palitra-love, taisabai, drafts, vhod, chat из Caddyfile. Compose монтирует ./sites в /srv/sites:ro. panel и корень synapse вне автоматической выкладки.
FR-2: обрабатываются только изменения base→head; live должен совпадать с base либо отсутствовать вместе с base. Локальные расхождения журналируются; удаления не переносятся. Тесты любого расширения, скрытые пути, cabinet.html, Caddyfile/compose и БД исключены.
FR-3: JS batch preflight, атомарная запись в том же каталоге, копия каждого заменённого файла с hash/mode/state. HTTP200+точные байты на домене сайта. Последняя операция откатывается --rollback; новые локальные изменения или повреждённая копия останавливают откат до записи.
FR-4: installer из точного Git SHA; существующие права/ключи/защиты не меняет. Копия до изменений, установка systemd, сохранение существующего BASELINE или создание нового; только avokado3/index.html из daca87ad по двум обязательным SHA256. Это адресный bootstrap, CI gate остальных выпусков сохранён.
FR-5: штатная песочница systemd с @pkey, Node apt, fast CI tree gate из PR560, таймер1мин сохранены. Ubuntu24.04 CI проверяет установку, BASELINE, hash сайта и откат без production-доступа; HTTP проверки CI направлены только в loopback.
FR-6: в конце installer выводит df -h /, du -xh --max-depth=2 /opt /var /root, docker system df и ГОТОВО либо ОШИБКА. Очистки и увеличения диска нет, автоматического удаления backup нет.
Границы: ops/autosync/**, .github/workflows/static-autosync.yml, specs/098-static-autosync/**. Сервер/merge/main/метки запрещены. Код сдаётся на ревью Claude, установка отдельно.
