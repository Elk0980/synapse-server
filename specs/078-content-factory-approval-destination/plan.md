# План CF28

1. Зафиксировать свежие baseline и сначала воспроизвести failing A→B regression на существующем коде.
2. В autoposting-transport.js мигрировать destination_revision, сравнивать target/provider/decrypted effective token при saveSettings в текущей транзакции. Добавить internal sync approvalDestination; getSettings DTO не менять.
3. В autoposting.js добавить nullable approval binding columns; сохранять их в approvePrepared/setPlatformReview. При новой постановке сравнить binding/profile/current channel с awaited settings внутри нынешнего BEGIN. DTO согласования новой постановки может читать только sync context; deliveryApproved сохраняет content-only семантику и прежние runtime guards.
4. Meaningful synthetic memory SQLite в новом autoposting-approval-destination.test.js; transport fetch запрещён. Existing fixtures дополнить только sync adapter, не ослаблять assertions.
5. Targeted/regression, reverse patch integrity, Spec Kit converge/gate и diff check, финальные SHA, STOP.

## Владение

Root подтвердил ops/crm/autoposting.js, autoposting-transport.js, новый autoposting-approval-destination.test.js, existing autoposting.test.js/autoposting-transport.test.js и четыре документа specs078. Дополнительно разрешены только adapter fixture в autoposting-calendar-edge.test.js, autoposting-calendar.test.js, autoposting-variants-history.test.js, media-mentor-legacy-adaptation.test.js, media-mentor-transfer.test.js. CRM server wiring не требуется: transport уже передан целиком. Остальные paths только чтение.
