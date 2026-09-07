# Palitra — локальные шрифты

- Lora Regular и Italic, variable 400–700: https://github.com/google/fonts/tree/main/ofl/lora
- Golos Text, variable 400–900: https://github.com/google/fonts/tree/main/ofl/golostext

Исходные TTF из официального репозитория Google Fonts преобразованы в WOFF2 с помощью fontTools. Глифы и таблицы символов не сокращались. Лицензии SIL OFL 1.1 сохранены рядом.

Проверено наличие всех 66 прописных/строчных букв русского алфавита, включая Ё/ё, во всех трёх файлах. Кириллица загружается из этих локальных файлов, а не через CDN. Lora Regular — для h1, главного оффера, h3 и вопросов квиза; Lora Italic — для остальных h2 (заголовков секций). Golos Text — для текста, кнопок и элементов форм. Размеры, отступы и межстрочные интервалы первого экрана сохранены; смена гарнитуры может менять переносы строк. Fallback: Georgia/serif для заголовков и Arial/sans-serif для текста, font-display: swap.

Источник прямого начертания: https://github.com/google/fonts/blob/main/ofl/lora/Lora%5Bwght%5D.ttf — локальный lora-regular.woff2, без сокращения cmap. На оба начертания Lora распространяется Lora-OFL.txt.
