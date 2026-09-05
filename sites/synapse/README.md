# Сайт Synapse Business

## Трекинг источников

`track.js` отправляет на same-origin endpoint `POST /track` событие просмотра страницы и конверсионные клики:
телефон, Telegram, WhatsApp, переход в 2ГИС или Яндекс Карты, открытие прайса и отправку квиза.
Скрипт не задерживает переходы и молча игнорирует сетевые ошибки, включая ответ `404`.

Анонимный `clientId` хранится без ограничения срока в `localStorage` под ключом `synapse_cid`. Первичный
источник, UTM-метки, referrer и посадочная страница хранятся 30 дней в `synapse_ft`. Явная UTM-метка
начинает новый first-touch период. Телефоны, значения полей форм и другие персональные данные не собираются.

При `navigator.doNotTrack === "1"` скрипт отключён и события не отправляются.

Событие имеет JSON-формат:

```json
{
  "type": "visit | click",
  "companyCode": "alvi | avokado",
  "clientId": "anonymous UUID",
  "page": "/path#section",
  "landingPage": "/first-path",
  "referrer": "https://source.example/",
  "utmSource": "",
  "utmMedium": "",
  "utmCampaign": "",
  "utmContent": "",
  "utmTerm": "",
  "source": "2gis | yandex | google | instagram | vk | telegram | whatsapp | direct | hostname",
  "target": "phone | telegram | whatsapp | 2gis | yandex | price | quiz | other",
  "label": "текст ссылки длиной до 60 символов",
  "ts": 1788566400000
}
```
