# Проверки (05.11.2026, Бангкок)

Реализовано и проверено локально. Не подключено и не проверено в рабочей системе: нет merge и выпуска.

- Значки: `PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers node specs/114-app-icon/render-icons.cjs B` (Chromium 1243,
  Playwright 1.63). Источник — утверждённая `brand/sapphire-approved.webp`, буквы не перенабраны;
  32 px — статичный кадр `.sb-orb` (анимации на кадре 0%, без living-logo.js). Все PNG без прозрачности, фон
  #020d24; maskable — логотип в 80% холста. Снимок: `preview.png` (сейчас / A / B, 180 и 32 px, тёмный и светлый
  фон). На 32 px шар читается, надпись на 32 px не ставится.
- Вариант A (альтернатива, только шар на всех размерах): `render-icons.cjs A <каталог>` — замена пяти PNG
  без изменений кода. Вариант T (прозрачный фон) отклонён Владом: белая надпись не видна на светлом фоне.
- jsdom: `node --test sites/synapse/app-identity.test.cjs` — 7/7. Без изменений в cabinet.html/people.html и
  манифестах — 4 из 7 падают.
  До входа, владелец (даже с palitra-love среди компаний), Авокадо, смешанный пользователь — synapse-ссылки и
  «Синапс». Только palitra-love — manifest-palitra/people-palitra, hugh-icon-32/180, прежний apple-title
  (в people.html — без него, как было). Смена manifest кабинетом при переходе по разделам не сбивает вариант
  Palitra; board.webmanifest для доски владельца остаётся. Повторная проверка whoami после отправки формы входа.
- Chromium (Playwright, заглушка `/content/whoami`, настоящие cabinet.html и cabinet/people.html): у тех же четырёх
  пользователей ссылки, имя из загруженного манифеста и apple-title совпадают с ожидаемыми, значок 32 px грузится,
  ошибок JS нет.
- Регрессия: все тесты sites/, которые читают cabinet.html, people.html, манифесты или hugh-icon (jsdom 24.1.3), — 473/473.
- `python tools/spec-kit/gate.py check` — ok.
