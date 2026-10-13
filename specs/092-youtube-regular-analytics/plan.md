# План
Один писатель source checkout: Codex. База623f84f04741ee8db1d26de54371a01320449c77, ветка codex/server-revenue-analytics-20261008.
Claude YOUTUBE_AUDIT завершён только чтением; находки лично подтверждаются. Claude ремонтирует только собственные изолированные два модуля/тесты в private WORK; source и shared-файлы только Codex.
social-youtube-access/stats переиспользуют подготовленный30Sept кандидат. social-analytics-credentials добавляет отдельный провайдер; social-adapters связывает его, сохраняя vkDirect; social-stats меняет retryable/backoff и platform capability без отката функций. social-stats-http/server/cabinet связываются точечными патчами.
Миграции сохраняют старые таблицы и историю; прежний код игнорирует новые провайдерные данные. Перед рабочей установкой backup и точный rollback, свежая база и подтверждённый один писатель. Не использовать старые образы и override как новую базу.
Проверки: новые access/stats/adapter/http/e2e тесты, существующие VK/TG/Onlypult и social stats, API ACL/DOM, Spec Kit gate и converge. Доказательства live отделены от локальных.
