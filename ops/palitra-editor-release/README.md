# Локальный кодовый пакет Palitra 35 + редактор 12–18

Статус: **собран локально; не установлен; runtime и Sharp на сервере не проверены этим пакетом**.
Единственный исполнитель серверной установки — Root. До записи нужна свежая проверка владельца общих ресурсов.

## Состав и границы

- `payload/server/`: шесть модулей с конечными именами рядом с `server.js`; native feature,
  модель фото, структурная проверка изображения, Sharp adapter, validator/CAS и occasions.
- `payload/static/cabinet/`: десять файлов входа в редактор, фото и управления отдельными правами.
- `payload/static/`: пять файлов нового редактора прайса, occasions, четыре официальных Nunito Sans v19
  и сопровождающая лицензия `palitra-editor-fonts/NunitoSans-OFL.txt`.
- `patches/upstream-patches.cjs`: неизменённый insert-only кандидат 35.
- `patches/release-patches.cjs`: вариант с обязательным абсолютным путём Sharp и фиксированным
  `https://palitra-love-draft-1.synapsebusiness.ru/`; затем тот же price CAS и ссылка preview.
- `SOURCE_INTEGRATION_MANIFEST.json`, `FONT_MANIFEST.json`, `SOURCE_PROVENANCE.json`, `BUILD_MANIFEST.json`: состав и SHA.

Данные прайса, фото клиентов, полный BASE/server.js, старый catalog/index, auth-store, секреты,
переписки, QA и mock серверы в пакет не включены. Каталог/главная/публичный «Состав» требуют отдельных
точечных хунков Root на свежих исходниках. Пакет не задаёт часовой пояс компании; праздники остаются
выключенными при отсутствии доверенного пояса.

Две адаптации расположения исходного payload: Node-ветка `cabinet/site-photos-core.js`
теперь требует соседний `./palitra-photo-model.js`, а Node-ветка `palitra-editor-model.js` —
соседний `./palitra-occasions.js`. Browser-ветки прежние. Native feature уже использует
соседние конечные имена; fallback в исходную WORK-структуру не требуется при установке всех шести файлов.
Модули `.cjs` из источника 35 сохранены с конечными именами `.js`, как требует интеграционный контракт.
Требуется CommonJS-окружение content-сервера; `package.json` с `type: module` не совместим с этими именами.

Nunito Sans распространяется по SIL Open Font License 1.1. Полный текст лицензии и copyright включены
рядом с четырьмя неизменёнными файлами шрифта; они устанавливаются вместе. Источник лицензии —
[официальный каталог Google Fonts](https://raw.githubusercontent.com/google/fonts/main/ofl/nunitosans/OFL.txt).
SHA256 лицензии: `efbb0c9e864cef973982d9a17567e6be5c3d1759695574586f3f18c7ecca064b`.

## Проверка без записи

`install.cjs` не имеет путей по умолчанию. Нужны все параметры:

```text
node install.cjs --inspect-only --content-dir ABS_CONTENT --static-dir ABS_STATIC_ROOT --preview-file ABS_PREVIEW_INDEX --preview-sha256 ACTUAL_PREVIEW_SHA --sharp-module ABS_INSTALLED_SHARP
node install.cjs --check-only --content-dir ABS_CONTENT --static-dir ABS_STATIC_ROOT --preview-file ABS_PREVIEW_INDEX --preview-sha256 ACTUAL_PREVIEW_SHA --sharp-module ABS_INSTALLED_SHARP --baseline ABS_BASELINE_JSON
```

`ABS_*` и SHA выше — обозначения, их нельзя запускать как реальные параметры. `--static-dir` — корень
статического origin кабинета: редактор прайса располагается в корне, редактор фото — в `cabinet/`.
`--preview-file` — только конкретный существующий `index.html` или `bot-preview-index.html` приложения бота.
`--content-dir` — фактический каталог кода с `server.js`, а не `/data` по предположению.
`--sharp-module` — уже установленный каталог официального npm-пакета `sharp` версии **0.35.5**, который Root проверил
под тем же runtime. Установщик проверяет имя/version/main/package.json, **не выполняет декодирование**.
Root отдельно проверяет JPEG/EXIF, PNG, WebP, повреждённые файлы и предел 40 Мп.

Для этой проверки поставляется `verify-decoder.cjs`:

```text
node verify-decoder.cjs --sharp-module ABS_INSTALLED_SHARP
```

Он генерирует цветные 320×500 пикселей в памяти, сравнивает orientation 1/6 JPEG/PNG/WebP с image-probe,
проверяет отказ для обрезанных файлов и испорченного PNG IDAT с правильным CRC. Предел 40 Мп проверяется
по большому заголовку до выделения пикселей; настоящий полный кадр >40 Мп не создаётся.
Проверка не использует клиентские фото и не записывает файлы. Наличие файла теста не доказывает его
успешное выполнение под серверным runtime.

`--inspect-only` выводит baseline JSON в stdout и не пишет файлы. Root сохраняет его штатным разрешённым
способом и сверяет 29 целей. `--check-only` требует этот baseline: каждый файл должен иметь точный SHA
или `null`, подтверждающий отсутствие. Для `server.js` принимается только
`7b60187397cb11fe7e382682fb65e5a1600b35255bf85c8bbdfe2b122c35d8a2`.
Любой другой SHA, отсутствующий/повторный якорь, symlink, неполный baseline или несовпавший SHA пакета — отказ.
Проверка восстанавливает исходные байты server.js удалением вставок и проверяет синтаксис кандидата в памяти.

## Запись и откат — только после принятого preflight Root

```text
node install.cjs --apply [те же обязательные параметры] --baseline ABS_BASELINE_JSON --backup-dir ABS_EXISTING_BACKUP_ROOT
node install.cjs --rollback ABS_TRANSACTION_MANIFEST --check-only
node install.cjs --rollback ABS_TRANSACTION_MANIFEST
```

Backup-root должен существовать и находиться вне content/static/release. Перед первой заменой записываются
все резервные копии, SHA и manifest транзакции. Каждая целевая замена использует временный соседний файл,
fsync и atomic rename; это атомарность **одного файла**, не всех 29 файлов вместе. При частичном отказе
manifest остаётся для проверки фактических SHA и явного rollback. Автоматических повторов нет.
Разрешено создать только отсутствующие `cabinet/` и `palitra-editor-fonts/` в заданном static-root.
Существующие файлы сохраняют числовой mode; uid/gid после rename определяются пользователем установки.
Root должен запускать запись под штатным владельцем файлов, если требуется сохранить владельца.

Rollback сначала проверяет весь whitelist и все резервные копии. Файл должен иметь SHA установленного
пакета либо уже восстановленный SHA; неизвестное стороннее изменение останавливает откат до записи.
Прежние файлы восстанавливаются, новые удаляются, созданные пакетом пустые каталоги убираются.
Backup и manifest сохраняются. Содержимое БД и загруженные позже материалы rollback не трогает.

Установщик не выполняет Docker build/recreate, не перезапускает сервер, не меняет Caddy/CSP/auth-store,
не пишет прайс, не устанавливает Sharp, не выдаёт права и не обращается к сети. В baked image изменение
локальных файлов само по себе не активирует приложение. Сборку и runtime activation делает Root отдельно
по фактическим mount/build/runtime сведениям. До проверки runtime пакет нельзя объявлять LIVE.

## Локальные проверки

```text
node --check install.cjs
node build-manifest.cjs
node tests/package-checks.cjs ABS_READONLY_BASE_SERVER
```

BASE читается только в память; полный сервер не сохраняется. Установку/частичный отказ/откат проверяет
виртуальная файловая система в памяти. Это проверка логики локального пакета, не реальный серверный тест.
`BUILD_MANIFEST.json` перечисляет каждый поставляемый файл, его размер и SHA256. После изменения файла
manifest нужно пересобрать и заново принять; это checksum, не криптографическая подпись.

Своих браузерных вкладок и фоновых процессов этот пакет не создаёт. Отчёт о проверке хранится отдельно
у Root; результаты и тексты клиентской задачи не добавляются в публичный Git.
