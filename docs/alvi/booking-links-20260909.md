# ALVI — Online Booking (онлайн-запись)

Owner supplied two public links after requesting that every «Записаться» action use YCLIENTS:

- https://n1070017.yclients.com/
- https://n396010.yclients.com/company/375899/personal/menu?o=

The second page rendered «Студия дизайна тела Авокадо», Иркутск, Красноказачья улица, 84. It is not used for ALVI booking buttons.

Assumption explicitly disclosed to Owner: the first supplied link is the intended ALVI widget. Its destination returned «Нет доступа к странице403» to the cloud browser on initial load and one reload. End-to-end widget functionality and its salon identity are UNKNOWN, not verified LIVE. No booking or customer details were submitted.

Implementation: main-page cards and quiz, price-page fallback cards and floating CTA, and dynamic price/showcase rendering use the supplied first link. A fixed renderer booking destination prevents older API price documents from restoring the previous Telegram destination. Static data links.book is updated too. Chat/help/certificate actions retain their original destinations. No visual styles, layout, photos or animation changed.

Validation: node --test docs/alvi/tests/booking-links.test.js covers legacy API input, both showcase groups, dynamic price, static HTML and retained chat/certificate links. Delivery and actual DOM hrefs must be checked after deployment. CRM persistence is deferred by Owner.
