# План
Source Codex единственный писатель codex/server-revenue-analytics-20261008 от623f84f. Claude COHORTS/REPAIR только изолированные кандидаты; факт чтения/модель и тестирование Codex отдельны.
Новый revenue-analytics-cohorts.js обрабатывает existing normalized revenue_records/cash, explicit scoped facts. Report подключает его к SQLite; trusted synchronous cohortFacts resolver допускается только внутри сервера, HTTP не принимает proof/историю/полноту. Без resolver нет выдуманных native links/НДС.
Кабинет показывает свою когорту и observationTo отдельно от календаря, причины неизвестности и проверенную экономику только по доступности. Старые API поля сохраняются.
Не изменять данные бизнеса и существующий пайплайн сайтов; native linkage/lead journal подключаются отдельным этапом с подтверждённым контрактом и рабочим доступом. Публичные proof endpoint не вводятся.
Проверки: новый движок, SQL/API integration, regression revenue/Direct/quality/cabinet, actual Spec gate/diff/converge. Root исправляет найденные границы даты/арифметики перед приёмкой.
