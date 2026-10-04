# Research: VK direct tools

Process: Spec Kit 1.0.0. Проверено 2026-10-04 чтением официальных исходников; реальные токены, права и сообщество не проверялись.

## Зафиксированные первоисточники

VKCOM/vk-api-schema: `333481bd082ad747d4873ef4a77f9247097eeef0`, текущий master на дату проверки, опубликованная схема API 5.199. Коммит датирован 2025-04-14: это версия контракта, не доказательство неизменности рабочего сервиса. VKCOM/vk-java-sdk: `3be91e5f2ab52133897e67f4b53379ee180d865a` используется для проверки multipart-загрузки.

| Решение | Подтверждение |
|---|---|
| Аналитике нужен user token | [stats.get / stats.getPostReach](https://github.com/VKCOM/vk-api-schema/blob/333481bd082ad747d4873ef4a77f9247097eeef0/stats/methods.json) допускают только `user`. |
| Описание допускает group token | [groups.edit](https://github.com/VKCOM/vk-api-schema/blob/333481bd082ad747d4873ef4a77f9247097eeef0/groups/methods.json#L462): `user,group`; обязательный положительный `group_id`, необязательный `description`; успех `response:1`. |
| Статическая обложка допускает group token | [photos.getOwnerCoverPhotoUploadServer](https://github.com/VKCOM/vk-api-schema/blob/333481bd082ad747d4873ef4a77f9247097eeef0/photos/methods.json#L983) и [saveOwnerCoverPhoto](https://github.com/VKCOM/vk-api-schema/blob/333481bd082ad747d4873ef4a77f9247097eeef0/photos/methods.json#L1762): `user,group`. |
| Повторное чтение доступно group token | [groups.getById](https://github.com/VKCOM/vk-api-schema/blob/333481bd082ad747d4873ef4a77f9247097eeef0/groups/methods.json#L1259) с `fields=description,cover`: `user,group,service`; [ответ](https://github.com/VKCOM/vk-api-schema/blob/333481bd082ad747d4873ef4a77f9247097eeef0/groups/responses.json#L109) содержит `response.groups[]`, не только старый массив `response[]`. |
| Не использовать getSettings с group token | [groups.getSettings](https://github.com/VKCOM/vk-api-schema/blob/333481bd082ad747d4873ef4a77f9247097eeef0/groups/methods.json#L1710) допускает только `user`. |

## Обложка: последовательность и ответ

1. Получить `upload_url` для положительного `group_id`; передать согласованные координаты `crop_x/y/x2/y2` и `is_video_cover=false`. Значения crop по умолчанию в схеме — `0,0,795,200`; это не универсальный размер подготовленного файла.
2. Выполнить multipart POST с полем `photo`: [официальный SDK](https://github.com/VKCOM/vk-java-sdk/blob/3be91e5f2ab52133897e67f4b53379ee180d865a/sdk/src/main/java/com/vk/api/sdk/actions/Upload.java#L74). Тело результата содержит `hash` и `photo`; [парсер SDK](https://github.com/VKCOM/vk-java-sdk/blob/3be91e5f2ab52133897e67f4b53379ee180d865a/sdk/src/main/java/com/vk/api/sdk/queries/upload/UploadQueryBuilder.java#L60) допускает прямой объект либо оболочку `response`.
3. Передать полученные `hash,photo` в `saveOwnerCoverPhoto`. [Ответ](https://github.com/VKCOM/vk-api-schema/blob/333481bd082ad747d4873ef4a77f9247097eeef0/photos/responses.json#L514) — `response.images[{url,width,height,...}]`, не число `1`.
4. Заново прочитать группу. [cover](https://github.com/VKCOM/vk-api-schema/blob/333481bd082ad747d4873ef4a77f9247097eeef0/base/objects.json#L738) содержит `enabled`, опциональные `images`, `original_image`, `crop_params`, `photo_id`. Одно `enabled=1` не доказывает установку именно нового изображения.

Схема задаёт `upload_url` как URI без перечня хостов. Проверка HTTPS, запрет локальных/приватных адресов и редиректов, ограничение полученного адреса доверенным ответом VK, таймауты и предел файла — собственные меры Synapse. Нельзя выдавать конкретный allowlist доменов за контракт VK без источника. На upload-сервер не пересылаются токен API, cookies или заголовки доступа Synapse.

## Что оставлено за границей

- [Аватар, создание альбома, загрузка в альбом](https://github.com/VKCOM/vk-api-schema/blob/333481bd082ad747d4873ef4a77f9247097eeef0/photos/methods.json): `user`. Товарные операции [market.get/add/edit/getProductPhotoUploadServer/saveProductPhoto](https://github.com/VKCOM/vk-api-schema/blob/333481bd082ad747d4873ef4a77f9247097eeef0/market/methods.json): `user`. Новых прав ради них не запрашиваем.
- Фото для сообщения: `photos.getMessagesUploadServer(peer_id)` → multipart `photo` → `photos.saveMessagesPhoto(photo,server,hash)` поддерживают `user,group`. Это сохранение вложения, не отправка сообщения; в данном инкременте транспорт не расширяется.
- Callback API, Long Poll и перенос клиентских сообщений в общий проектный чат не входят в работу. Existing client-dialogs хранит Telegram-данные отдельно от проектных комнат и ИИ.

## Неустановленные сведения

`access_token_type` в схеме определяет тип токена, но не уже выданные scopes, роль пользователя, возможность приложения или доступность операции. Актуальные имена разрешений, их числовые маски и дополнительные ограничения выдачи здесь не утверждаются. Страницы dev.vk.com не открылись инструментом; точные допустимые размеры/форматы обложки из этих источников не установлены. Пределы реализации следует обозначать как пределы Synapse. Проверка рабочего подключения остаётся отдельным этапом после разрешённого развёртывания.

Для проверки типа токена важно: [users.get](https://github.com/VKCOM/vk-api-schema/blob/333481bd082ad747d4873ef4a77f9247097eeef0/users/methods.json) допускает `user,group,service`; один успех этого метода не является эксклюзивным доказательством пользовательского токена. [account.getProfileInfo](https://github.com/VKCOM/vk-api-schema/blob/333481bd082ad747d4873ef4a77f9247097eeef0/account/methods.json) допускает только `user`; лишние персональные поля ответа нельзя сохранять или возвращать в DTO проверки. `groups.getTokenPermissions` допускает только `group`, но возвращает маску/список разрешений без ID сообщества. Чтение публичной группы с явно заданным `group_id` проверяет ответ о цели, а не принадлежность ей токена; реализация не должна смешивать эти утверждения.
