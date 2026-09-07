# Palitra — локальные шрифты

- Lora Italic, variable 400–700: https://github.com/google/fonts/tree/main/ofl/lora
- Golos Text, variable 400–900: https://github.com/google/fonts/tree/main/ofl/golostext

Исходные TTF из официального репозитория Google Fonts преобразованы в WOFF2 с помощью fontTools. Глифы и таблицы символов не сокращались. Лицензии SIL OFL 1.1 сохранены рядом.

Проверено наличие всех 66 прописных/строчных букв русского алфавита, включая Ё/ё, в обоих файлах. Кириллица загружается из этих локальных файлов, а не через CDN. Lora подключена только как italic для заголовков, Golos Text — normal для текста. Типографика первого экрана сохранена для защиты согласованной геометрии.
