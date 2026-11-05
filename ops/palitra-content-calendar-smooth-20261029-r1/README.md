# Palitra: плавная центральная лента дат

Spec: specs/049-palitra-content-calendar

Нативная горизонтальная прокрутка и scroll-snap центрируют выбранную дату после остановки. Семь видимых ячеек; окно93даты пополняется при продолжении прокрутки. Клик, стрелки и полный календарь используют центрирование; reduced-motion без анимации. Mouse drag следует расстоянию, вертикальный touch сохраняется. Выбор обновляет чтение дня один раз после конечной даты.

Проверки включают физические touch IDs после native pointercancel, resize с прежним snap offset и сохранение scrollport при перерисовке контента. Нет изменения формы, транспорта или модели данных. Макет и реальные жесты проверяет основной Codex отдельно; DOM-тесты не подтверждают Safari/iPhone.

Только3existingstatic: HTMLверсии двухресурсов, contenttasksJS, append-onlyCSS. База свежая послеR5. Helper отличается от принятогоR3 толькоNAME/SCOPE; offlineguards сохранены. FreshBASE/backup/ownlease/singleapply/independentinspect обязательны. Runtime/schema/auth/price/servicewrites0. ПредыдущиеapplyНЕповторять. Полныйdeployветкинеиспользовать: управляемаяliveоболочка новее базовыхGitкопий.
