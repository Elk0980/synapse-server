'use strict';

/* Перенос согласованной версии контент-плана в ЧЕРНОВИКИ существующего автопостинга.
   Создаются только карточки со статусом draft: ни публикации, ни постановки в очередь,
   ни выбора каналов, ни времени отправки, ни обращений в сеть.
   Согласование плана — решение по тексту плана, а не согласование публикации: одобрение
   карточки в автопостинге остаётся отдельным действием владельца.
   Ничего не выдумывается: текста поста, материалов и каналов в плане нет, поэтому
   в карточке они остаются пустыми, и автопостинг сам показывает их как незаполненные. */

const {company, fail, object, revision, text} = require('./company-information');

const ORIGIN = 'media-mentor-plan';
const TITLE_LIMIT = 200;
const NOTICE = 'Перенос создаёт только черновики автопостинга. Публикация не выполняется, ' +
  'в очередь ничего не ставится, каналы и время не выбираются. Текст поста, материалы и каналы ' +
  'остаются незаполненными — их заполняет человек. Согласование плана не является согласованием ' +
  'публикации: карточку всё равно одобряет владелец в автопостинге.';
const MISSING = Object.freeze(['Текст поста', 'Материалы (фото или видео)', 'Каналы публикации',
  'Дата и время отправки']);
// Защита от повтора действует только внутри одной версии плана: новая согласованная версия —
// это новые черновики, и заявлять большее нельзя.
const REPEAT_SCOPE = 'Повтор защищён в пределах одной версии плана';
const NEW_VERSION_NOTICE = 'Перенос новой согласованной версии создаёт новые черновики. ' +
  'Ранее перенесённые черновики остаются в автопостинге как есть: они не обновляются, ' +
  'не заменяются и не удаляются — разберите их вручную.';
const CONTEXT_NOTICE = 'Это задание и описание исходника из согласованной версии плана и брифа. ' +
  'Версии неизменяемы, поэтому задание не меняется задним числом. Исходник описан словами — ' +
  'это не готовое медиа: файл нужно найти или снять и загрузить в карточку вручную.';
// Приём файлов уже есть в автопостинге: Медиа-наставник им пользуется, своего склада не заводит.
const MATERIAL_UPLOAD_PATH = '/content/publishing-assets';
const MATERIAL_NOTICE = 'Материал — это файл, загруженный существующим приёмом материалов ' +
  'автопостинга и приложенный к карточке. Описание исходника из брифа материалом не является ' +
  'и в карточку автоматически не подставляется.';

function createMediaMentorTransfer(db, {mentor, autoposting, information, now = Date.now} = {}) {
  if (!mentor || typeof mentor.get !== 'function' || !autoposting || typeof autoposting.get !== 'function' ||
    !information || typeof information.get !== 'function') {
    throw Error('Media mentor transfer requires mentor, autoposting and company information');
  }
  db.exec(`CREATE TABLE IF NOT EXISTS media_mentor_plan_transfers (
    id INTEGER PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id),
    plan_revision INTEGER NOT NULL, brief_revision INTEGER NOT NULL, day_count INTEGER NOT NULL,
    profile_revision INTEGER NOT NULL, created_at TEXT NOT NULL, actor_id INTEGER,
    actor_name TEXT NOT NULL DEFAULT '', UNIQUE(company_id,plan_revision));
    CREATE TABLE IF NOT EXISTS media_mentor_plan_transfer_items (
    transfer_id INTEGER NOT NULL REFERENCES media_mentor_plan_transfers(id),
    day_index INTEGER NOT NULL, plan_date TEXT NOT NULL, plan_platform TEXT NOT NULL,
    plan_asset_id TEXT NOT NULL DEFAULT '',
    post_id INTEGER NOT NULL UNIQUE REFERENCES autoposting_posts(id),
    PRIMARY KEY(transfer_id,day_index));
    CREATE TABLE IF NOT EXISTS media_mentor_variant_transfers (
    id INTEGER PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id),
    idea_id TEXT NOT NULL, platform TEXT NOT NULL, content_revision INTEGER NOT NULL,
    plan_revision INTEGER NOT NULL, brief_revision INTEGER NOT NULL, plan_date TEXT NOT NULL,
    planned_date TEXT NOT NULL DEFAULT '', planned_time TEXT NOT NULL DEFAULT '',
    plan_timezone TEXT NOT NULL DEFAULT '', plan_asset_id TEXT NOT NULL DEFAULT '',
    post_id INTEGER NOT NULL UNIQUE REFERENCES autoposting_posts(id), created_at TEXT NOT NULL,
    actor_id INTEGER, actor_name TEXT NOT NULL DEFAULT '',
    UNIQUE(company_id,idea_id,platform,content_revision));
    CREATE INDEX IF NOT EXISTS media_mentor_variant_transfers_post_idx
    ON media_mentor_variant_transfers(post_id,company_id);
    CREATE TRIGGER IF NOT EXISTS media_mentor_variant_transfers_immutable_update
    BEFORE UPDATE ON media_mentor_variant_transfers
    BEGIN SELECT RAISE(ABORT,'Immutable media mentor variant transfer'); END;
    CREATE TRIGGER IF NOT EXISTS media_mentor_variant_transfers_immutable_delete
    BEFORE DELETE ON media_mentor_variant_transfers
    BEGIN SELECT RAISE(ABORT,'Immutable media mentor variant transfer'); END;
    CREATE TRIGGER IF NOT EXISTS media_mentor_plan_transfers_immutable_update
    BEFORE UPDATE ON media_mentor_plan_transfers
    BEGIN SELECT RAISE(ABORT,'Immutable media mentor plan transfer'); END;
    CREATE TRIGGER IF NOT EXISTS media_mentor_plan_transfers_immutable_delete
    BEFORE DELETE ON media_mentor_plan_transfers
    BEGIN SELECT RAISE(ABORT,'Immutable media mentor plan transfer'); END;`);
  // Связь дня с исходником добавлена после первых переносов: расписка старого образца
  // получает колонку, а не переписывается.
  const itemColumns = new Set(db.prepare('PRAGMA table_info(media_mentor_plan_transfer_items)').all().map((row) => row.name));
  if (!itemColumns.has('plan_asset_id')) {
    db.exec("ALTER TABLE media_mentor_plan_transfer_items ADD COLUMN plan_asset_id TEXT NOT NULL DEFAULT ''");
  }
  const iso = () => new Date(now()).toISOString();

  function receiptOf(owner, planRevision, strict = false) {
    const row = db.prepare(`SELECT id,plan_revision planRevision,brief_revision briefRevision,day_count dayCount,
      profile_revision profileRevision,created_at transferredAt,actor_id actorId,actor_name actorName
      FROM media_mentor_plan_transfers WHERE company_id=? AND plan_revision=?`).get(owner.id, planRevision);
    if (!row) return null;
    // Соединение по company_id: карточка чужой компании в расписку попасть не может.
    // Состояние материала читается из самой карточки автопостинга: отдельного склада
    // у Медиа-наставника нет и быть не должно.
    const items = db.prepare(`SELECT i.day_index dayIndex,i.plan_date planDate,i.plan_platform planPlatform,
      i.plan_asset_id planAssetId,i.post_id postId,p.revision postRevision,p.status cardStatus,p.media_urls mediaUrls
      FROM media_mentor_plan_transfer_items i JOIN autoposting_posts p ON p.id=i.post_id AND p.company_id=?
      WHERE i.transfer_id=? ORDER BY i.day_index`).all(owner.id, row.id).map((item) => {
      const media = JSON.parse(item.mediaUrls || '[]');
      return {...item, mediaUrls: media, mediaCount: media.length, hasMedia: media.length > 0};
    });
    const complete = items.length === row.dayCount;
    if (!complete && strict) {
      fail(409, 'Не удалось восстановить перенесённые черновики. Проверьте прошлый перенос.', 'TRANSFER_INCOMPLETE');
    }
    const {id, ...receipt} = row;
    return {...receipt, complete, items, postIds: items.map((item) => item.postId)};
  }

  /* Задание дня и описание исходника читаются из НЕИЗМЕНЯЕМЫХ версий плана и брифа,
     на которые ссылается расписка. Ничего не копируется в карточку и не обрезается:
     источник правды остаётся один, а последующие правки брифа задание не переписывают. */
  function enrich(code, receipt) {
    if (!receipt || !receipt.items.length) return receipt;
    const planVersion = mentor.planVersion(code, receipt.planRevision);
    const briefVersion = mentor.briefVersion(code, receipt.briefRevision);
    const assets = new Map(briefVersion.fields.assets.map((asset) => [asset.id, asset]));
    return {...receipt, items: receipt.items.map((item) => {
      const day = planVersion.days[item.dayIndex] || null;
      return {...item, topic: day ? day.topic : '', hook: day ? day.hook : '',
        format: day ? day.format : '', role: day ? day.role : '',
        mentorNote: day ? day.mentorNote : '',
        // Исходник — описание словами, а не готовое медиа: подставлять его в карточку нельзя.
        asset: item.planAssetId ? assets.get(item.planAssetId) || null : null};
    })};
  }

  /* Полный контекст конкретного черновика: задание дня, его исходник и весь бриф
     той версии, по которой план согласован. Нужен, чтобы исполнитель не искал вручную. */
  function context(code, postId) {
    const owner = company(db, code), id = Number(postId);
    if (!Number.isSafeInteger(id) || id < 1) fail(404, 'Черновик не найден', 'NOT_FOUND');
    // Соединение по company_id: чужой черновик контекст не отдаёт.
    const item = db.prepare(`SELECT t.plan_revision planRevision,t.brief_revision briefRevision,
      t.created_at transferredAt,t.actor_name actorName,i.day_index dayIndex,i.plan_date planDate,
      i.plan_platform planPlatform,i.plan_asset_id planAssetId
      FROM media_mentor_plan_transfer_items i
      JOIN media_mentor_plan_transfers t ON t.id=i.transfer_id
      JOIN autoposting_posts p ON p.id=i.post_id AND p.company_id=t.company_id
      WHERE t.company_id=? AND i.post_id=?`).get(owner.id, id);
    if (!item) fail(404, 'Этот черновик не переносился Медиа-наставником', 'NOT_FOUND');
    const planVersion = mentor.planVersion(code, item.planRevision);
    const briefVersion = mentor.briefVersion(code, item.briefRevision);
    const day = planVersion.days[item.dayIndex] || null;
    const asset = day && day.assetId ? briefVersion.fields.assets.find((row) => row.id === day.assetId) || null : null;
    // Материал — это файл, приложенный к карточке существующим приёмом автопостинга.
    // Описание исходника из брифа материалом не считается и им не подменяется.
    const card = autoposting.get(id, code);
    const material = {postId: id, postRevision: card.revision, cardStatus: card.status,
      mediaUrls: card.mediaUrls, mediaCount: card.mediaUrls.length, hasMedia: card.mediaUrls.length > 0,
      mediaKind: card.readiness.mediaKind, ready: card.readiness.ready, issues: card.readiness.issues,
      uploadPath: MATERIAL_UPLOAD_PATH, attachPath: `/autoposting/posts/${id}`, notice: MATERIAL_NOTICE};
    return {companyCode: owner.code.toLowerCase(), postId: id, planRevision: item.planRevision,
      briefRevision: item.briefRevision, transferredAt: item.transferredAt, transferredBy: item.actorName,
      dayIndex: item.dayIndex, planDate: item.planDate, planPlatform: item.planPlatform, day, asset,
      assetIsMedia: false, material, brief: briefVersion.fields, briefCreatedAt: briefVersion.createdAt,
      planCreatedAt: planVersion.createdAt, decision: planVersion.decision, notice: CONTEXT_NOTICE};
  }

  // Состояние переноса для интерфейса: что уже перенесено и можно ли переносить сейчас.
  function status(code) {
    const owner = company(db, code), snapshot = mentor.get(code);
    const plan = snapshot.plan, approval = snapshot.approval;
    const current = plan ? enrich(code, receiptOf(owner, plan.revision)) : null;
    const blocked = !plan ? 'План ещё не составлен'
      : approval.status !== 'approved' ? 'Переносить можно только согласованную версию плана'
        : current ? 'Эта версия плана уже перенесена' : '';
    const history = db.prepare(`SELECT plan_revision planRevision,brief_revision briefRevision,day_count dayCount,
      created_at transferredAt,actor_name actorName FROM media_mentor_plan_transfers
      WHERE company_id=? ORDER BY plan_revision DESC LIMIT 10`).all(owner.id).map((row) => ({...row}));
    const total = db.prepare('SELECT COUNT(*) n FROM media_mentor_plan_transfers WHERE company_id=?').get(owner.id).n;
    return {planRevision: plan ? plan.revision : null, briefRevision: snapshot.brief.revision,
      approvalStatus: approval.status, canTransfer: !blocked, blockedReason: blocked,
      current, notice: NOTICE, target: 'autoposting-drafts', createsPublications: false,
      schedules: false, choosesChannels: false, leavesUnfilled: MISSING,
      materialUploadPath: MATERIAL_UPLOAD_PATH, materialNotice: MATERIAL_NOTICE,
      // Сколько заданий ещё без файла: видно сразу, без открытия каждой карточки.
      awaitingMaterial: current ? current.items.filter((item) => !item.hasMedia).length : 0,
      previousTransfers: total, repeatProtection: REPEAT_SCOPE,
      // Предупреждение показывается только там, где оно правдиво: перенос уже был,
      // и следующий создаст ещё один набор черновиков рядом с прежними.
      newVersionNotice: total && !current ? NEW_VERSION_NOTICE : '',
      history};
  }

  function transfer(code, body, actor = {}) {
    object(body, ['planRevision', 'briefRevision']);
    revision(body.planRevision);
    revision(body.briefRevision);
    const actorId = Number.isSafeInteger(actor.userId) ? actor.userId : null;
    const actorName = actor.userName ? text(actor.userName, 200) : '';
    // Снимок и данные компании читаются до транзакции: у обоих модулей свои транзакции.
    const snapshot = mentor.get(code), profile = information.get(code);
    const plan = snapshot.plan;
    if (!plan) fail(404, 'План ещё не составлен', 'NOT_FOUND');
    if (body.planRevision !== plan.revision) fail(409, 'Версия плана уже изменилась. Обновите страницу.', 'STALE_PLAN');
    // Бриф мог уехать вперёд после согласования: называем именно эту причину, а не «не согласовано».
    if (body.briefRevision !== snapshot.brief.revision || plan.briefRevision !== snapshot.brief.revision) {
      fail(409, 'Бриф изменился. Обновите план и согласуйте заново.', 'BRIEF_CHANGED');
    }
    if (snapshot.approval.status !== 'approved') {
      fail(409, 'Переносить можно только согласованную версию плана', 'PLAN_NOT_APPROVED');
    }
    // Тема дня становится заголовком карточки: он короче, поэтому обрезать молча нельзя.
    for (const item of plan.days) {
      if (item.topic.length > TITLE_LIMIT) {
        fail(400, `Тема дня ${item.date} длиннее ${TITLE_LIMIT} символов и не поместится в заголовок карточки. Сократите тему в плане.`);
      }
    }
    const timezone = profile.profile.timezone || 'UTC';
    let created = false, receipt;
    db.exec('BEGIN IMMEDIATE');
    try {
      const owner = company(db, code);
      // Повторная проверка по сырым фактам внутри транзакции: между чтением снимка
      // и записью план, бриф или согласование могли измениться.
      const planRow = db.prepare('SELECT revision,brief_revision briefRevision,plan FROM media_mentor_plans WHERE company_id=?').get(owner.id);
      if (!planRow || planRow.revision !== body.planRevision) fail(409, 'Версия плана уже изменилась. Обновите страницу.', 'STALE_PLAN');
      const briefRow = db.prepare('SELECT revision FROM media_mentor_briefs WHERE company_id=?').get(owner.id);
      if (!briefRow || briefRow.revision !== body.briefRevision || planRow.briefRevision !== body.briefRevision) {
        fail(409, 'Бриф изменился. Обновите план и согласуйте заново.', 'BRIEF_CHANGED');
      }
      const decision = db.prepare(`SELECT decision,brief_revision briefRevision FROM media_mentor_plan_approvals
        WHERE company_id=? AND plan_revision=? ORDER BY id DESC LIMIT 1`).get(owner.id, body.planRevision);
      if (!decision || decision.decision !== 'approved' || decision.briefRevision !== body.briefRevision) {
        fail(409, 'Переносить можно только согласованную версию плана', 'PLAN_NOT_APPROVED');
      }
      // Защита от гонки: между чтением данных компании и записью их мог обновить другой процесс.
      // Обычная правка карточки компании перенос не блокирует — черновик просто запишет свежую версию.
      const locked = db.prepare('SELECT revision FROM company_information WHERE company_id=?').get(owner.id);
      if (!locked || locked.revision !== profile.revision) {
        fail(409, 'Данные компании изменились. Откройте раздел заново.', 'PROFILE_CHANGED');
      }
      receipt = receiptOf(owner, body.planRevision, true);
      if (!receipt) {
        const days = JSON.parse(planRow.plan).days;
        const time = iso();
        const transferId = db.prepare(`INSERT INTO media_mentor_plan_transfers
          (company_id,plan_revision,brief_revision,day_count,profile_revision,created_at,actor_id,actor_name)
          VALUES(?,?,?,?,?,?,?,?)`)
          .run(owner.id, body.planRevision, body.briefRevision, days.length, profile.revision, time, actorId, actorName)
          .lastInsertRowid;
        // Черновик и только черновик: статус draft, пустой текст, пустые материалы и каналы,
        // без времени отправки. day_key не заполняется: в автопостинге это слот D1…D7
        // недельного пакета, а в плане — календарная дата; сопоставлять их было бы выдумкой.
        const insert = db.prepare(`INSERT INTO autoposting_posts
          (company_id,status,title,text,media_urls,platform_ids,scheduled_at,timezone,profile_revision,
           created_at,updated_at,created_by,day_key,captions,origin,meta,sort_order,review_state)
          VALUES(?,'draft',?,'','[]','[]',NULL,?,?,?,?,?,'','{}',?,?,?,'draft')`);
        const link = db.prepare(`INSERT INTO media_mentor_plan_transfer_items
          (transfer_id,day_index,plan_date,plan_platform,plan_asset_id,post_id) VALUES(?,?,?,?,?,?)`);
        let order = (db.prepare('SELECT COALESCE(MAX(sort_order),0) m FROM autoposting_posts WHERE company_id=?')
          .get(owner.id).m || 0);
        for (const [index, item] of days.entries()) {
          // Указатель на карточке называет обе неизменяемые версии и конкретный исходник,
          // чтобы исполнитель не искал задание вручную. Само описание исходника сюда
          // не копируется: его отдаёт контекст черновика целиком, без обрезки.
          const meta = {format: item.format, role: item.role, hook: item.hook || '', idea: item.topic,
            hughNote: item.mentorNote || '',
            methodSource: `Медиа-наставник · план v${body.planRevision} · бриф v${body.briefRevision} · ` +
              `день ${item.date} · площадка ${item.platform} · ` +
              `исходник ${item.assetId || 'не указан'} · задание в разделе «Бриф и план»`};
          const postId = insert.run(owner.id, item.topic, timezone, profile.revision, time, time, actorId,
            ORIGIN, JSON.stringify(meta), ++order).lastInsertRowid;
          link.run(transferId, index, item.date, item.platform, item.assetId || '', postId);
        }
        receipt = receiptOf(owner, body.planRevision, true);
        created = true;
      }
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    // Карточки читаются штатным API уже после фиксации: autoposting.get открывает свою транзакцию.
    return {companyCode: String(code).toLowerCase(), created, alreadyTransferred: !created,
      ...enrich(code, receipt), posts: receipt.postIds.map((id) => autoposting.get(id, code)),
      notice: NOTICE, leavesUnfilled: MISSING, createsPublications: false,
      repeatProtection: REPEAT_SCOPE, newVersionNotice: NEW_VERSION_NOTICE};
  }

  /* ---------- Перенос ОТДЕЛЬНЫХ согласованных версий площадок ----------
     Единица переноса — версия идеи для одной площадки, а не день целиком. Каждая согласованная
     версия становится своим черновиком со своим полным текстом. Повтор безопасен: связь
     уникальна по (компания, идея, площадка, ревизия содержимого), поэтому второй вызов
     ничего не дублирует, а правка соседней версии на уже перенесённые не влияет.
     Старая расписка по дням (media_mentor_plan_transfer_items) не трогается — только читается. */
  const VARIANT_NOTICE = 'Перенос создаёт черновик автопостинга по каждой согласованной версии ' +
    'площадки. Публикации не создаются, в очередь ничего не ставится, каналы и время не выбираются. ' +
    'Плановая дата и время версии — это ориентир контент-плана, а не очередь публикации: ' +
    'время отправки владелец задаёт в автопостинге отдельно.';

  function variantItems(owner) {
    return db.prepare(`SELECT v.idea_id ideaId,v.platform,v.content_revision contentRevision,
      v.plan_revision planRevision,v.brief_revision briefRevision,v.plan_date planDate,
      v.planned_date plannedDate,v.planned_time plannedTime,v.plan_timezone planTimezone,
      v.plan_asset_id planAssetId,v.post_id postId,v.created_at transferredAt,v.actor_name actorName,
      p.status cardStatus,p.revision postRevision,p.media_urls mediaUrls
      FROM media_mentor_variant_transfers v
      JOIN autoposting_posts p ON p.id=v.post_id AND p.company_id=v.company_id
      WHERE v.company_id=? ORDER BY v.plan_date,v.idea_id,v.platform`).all(owner.id).map((row) => {
      const media = JSON.parse(row.mediaUrls || '[]');
      return {...row, mediaUrls: media, mediaCount: media.length, hasMedia: media.length > 0};
    });
  }

  // Что видно в кабинете: какие согласованные версии уже перенесены, а какие ждут переноса.
  function variantStatus(code) {
    const owner = company(db, code), snapshot = mentor.get(code);
    const done = new Set(variantItems(owner).map((item) => `${item.ideaId}|${item.platform}|${item.contentRevision}`));
    // Согласованной считается версия, решение по которой принято в действующем контексте брифа:
    // снимок Медиа-наставника уже фильтрует решения по текущей версии брифа.
    const approved = snapshot.variants.filter((item) => item.status === 'approved');
    const pending = approved.filter((item) => !done.has(`${item.ideaId}|${item.platform}|${item.contentRevision}`));
    return {planRevision: snapshot.plan ? snapshot.plan.revision : null,
      briefRevision: snapshot.brief.revision, approvedCount: approved.length,
      awaitingTransfer: pending.length, canTransfer: pending.length > 0,
      blockedReason: !snapshot.plan ? 'План ещё не составлен'
        : !approved.length ? 'Нет согласованных версий площадок'
          : pending.length ? '' : 'Все согласованные версии уже перенесены',
      items: variantItems(owner), notice: VARIANT_NOTICE,
      createsPublications: false, schedules: false, choosesChannels: false};
  }

  function transferVariants(code, body, actor = {}) {
    object(body, ['planRevision', 'briefRevision', 'selection']);
    revision(body.planRevision);
    revision(body.briefRevision);
    let selection = null;
    if (Object.hasOwn(body, 'selection')) {
      object(body.selection, ['ideaId', 'platform', 'contentRevision']);
      const ideaId = text(body.selection.ideaId, 100, true), platform = text(body.selection.platform, 100, true);
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(ideaId) ||
        !Number.isSafeInteger(body.selection.contentRevision) || body.selection.contentRevision < 1) {
        fail(400, 'Укажите идею, площадку и текущую версию содержимого');
      }
      selection = {ideaId, platform, contentRevision: body.selection.contentRevision};
    }
    // Проверяется дважды: сначала снимок, затем факты внутри транзакции.
    const selectedVariant = days => {
      const idea = days.find(item => item.ideaId === selection.ideaId);
      if (!idea) fail(404, 'Идея плана не найдена', 'IDEA_NOT_FOUND');
      if (!Object.hasOwn(idea.variants || {}, selection.platform)) fail(400, 'У идеи нет версии для выбранной площадки');
      const variant = idea.variants[selection.platform];
      if (variant.contentRevision !== selection.contentRevision) fail(409, 'Версия площадки уже изменилась. Обновите план.', 'STALE_VARIANT');
      if (variant.excluded === true || !variant.text) fail(409, 'Пустая или исключённая версия не переносится', 'VARIANT_NOT_APPROVABLE');
      return idea;
    };
    const actorId = Number.isSafeInteger(actor.userId) ? actor.userId : null;
    const actorName = actor.userName ? text(actor.userName, 200) : '';
    const snapshot = mentor.get(code), profile = information.get(code);
    const plan = snapshot.plan;
    if (!plan) fail(404, 'План ещё не составлен', 'NOT_FOUND');
    if (body.planRevision !== plan.revision) fail(409, 'Версия плана уже изменилась. Обновите страницу.', 'STALE_PLAN');
    if (body.briefRevision !== snapshot.brief.revision || plan.briefRevision !== snapshot.brief.revision) {
      fail(409, 'Бриф изменился. Обновите план и согласуйте заново.', 'BRIEF_CHANGED');
    }
    const ideas = new Map(plan.days.map((day) => [day.ideaId, day]));
    for (const idea of selection ? [selectedVariant(plan.days)] : plan.days) {
      if (idea.topic.length > TITLE_LIMIT) {
        fail(400, `Тема дня ${idea.date} длиннее ${TITLE_LIMIT} символов и не поместится в заголовок карточки. Сократите тему в плане.`);
      }
    }
    const timezone = profile.profile.timezone || 'UTC';
    const created = [], skipped = [];
    db.exec('BEGIN IMMEDIATE');
    try {
      const owner = company(db, code);
      // Повторная сверка по сырым фактам внутри транзакции: план, бриф и решения могли измениться
      // между чтением снимка и записью. Клиентские поля здесь ни на что не влияют.
      const planRow = db.prepare('SELECT revision,brief_revision briefRevision,plan FROM media_mentor_plans WHERE company_id=?').get(owner.id);
      if (!planRow || planRow.revision !== body.planRevision) fail(409, 'Версия плана уже изменилась. Обновите страницу.', 'STALE_PLAN');
      const briefRow = db.prepare('SELECT revision FROM media_mentor_briefs WHERE company_id=?').get(owner.id);
      if (!briefRow || briefRow.revision !== body.briefRevision || planRow.briefRevision !== body.briefRevision) {
        fail(409, 'Бриф изменился. Обновите план и согласуйте заново.', 'BRIEF_CHANGED');
      }
      const locked = db.prepare('SELECT revision FROM company_information WHERE company_id=?').get(owner.id);
      if (!locked || locked.revision !== profile.revision) {
        fail(409, 'Данные компании изменились. Откройте раздел заново.', 'PROFILE_CHANGED');
      }
      const insert = db.prepare(`INSERT INTO autoposting_posts
        (company_id,status,title,text,media_urls,platform_ids,scheduled_at,timezone,profile_revision,
         created_at,updated_at,created_by,day_key,captions,origin,meta,sort_order,review_state)
        VALUES(?,'draft',?,?,'[]','[]',NULL,?,?,?,?,?,'','{}',?,?,?,'draft')`);
      const link = db.prepare(`INSERT INTO media_mentor_variant_transfers
        (company_id,idea_id,platform,content_revision,plan_revision,brief_revision,plan_date,
         planned_date,planned_time,plan_timezone,plan_asset_id,post_id,created_at,actor_id,actor_name)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
      const seen = db.prepare(`SELECT post_id postId FROM media_mentor_variant_transfers
        WHERE company_id=? AND idea_id=? AND platform=? AND content_revision=?`);
      /* Решение обязано быть принято по ДЕЙСТВУЮЩЕЙ версии брифа: согласие, данное в прежнем
         контексте, переносить нечего. Связь, бриф, решение и повтор переноса — один контекст. */
      const decided = db.prepare(`SELECT decision FROM media_mentor_variant_approvals
        WHERE company_id=? AND idea_id=? AND platform=? AND content_revision=? AND brief_revision=?
        ORDER BY id DESC LIMIT 1`);
      const time = iso();
      let order = (db.prepare('SELECT COALESCE(MAX(sort_order),0) m FROM autoposting_posts WHERE company_id=?')
        .get(owner.id).m || 0);
      const days = JSON.parse(planRow.plan).days;
      if (selection) selectedVariant(days);
      for (const day of days) {
        if (selection && day.ideaId !== selection.ideaId) continue;
        for (const [platform, variant] of Object.entries(day.variants || {})) {
          if (selection && platform !== selection.platform) continue;
          // Пустая или исключённая версия материалом не является и в перенос не идёт.
          if (variant.excluded === true || !variant.text) continue;
          const decision = decided.get(owner.id, day.ideaId, platform, variant.contentRevision, body.briefRevision);
          if (selection && (!decision || decision.decision !== 'approved')) fail(409, 'Эта версия площадки ещё не согласована', 'VARIANT_NOT_APPROVED');
          if (!decision || decision.decision !== 'approved') continue;
          const already = seen.get(owner.id, day.ideaId, platform, variant.contentRevision);
          if (already) {
            const item = {ideaId: day.ideaId, platform, contentRevision: variant.contentRevision, postId: already.postId};
            if (selection) {
              const card = db.prepare('SELECT status cardStatus,archived_at archivedAt FROM autoposting_posts WHERE id=? AND company_id=?').get(already.postId, owner.id);
              if (!card) fail(404, 'Перенесённый черновик не найден', 'NOT_FOUND');
              item.cardStatus = card.cardStatus; item.archivedAt = card.archivedAt || null;
            }
            skipped.push(item); continue;
          }
          /* Указатель происхождения неизменяем по построению: он называет версии плана и брифа,
             идею, площадку и ревизию содержимого, по которым карточка создана. Последующие правки
             плана его не переписывают — они создают новую версию и новый перенос. */
          const meta = {format: variant.format || day.format, role: day.role,
            hook: variant.hook || day.hook || '', idea: day.topic,
            hughNote: variant.mentorNote || day.mentorNote || '',
            methodSource: `Медиа-наставник · план v${body.planRevision} · бриф v${body.briefRevision} · ` +
              `идея ${day.ideaId} · площадка ${platform} · версия содержимого ${variant.contentRevision} · ` +
              `плановый выход ${variant.plannedDate || day.date}${variant.plannedTime ? ` ${variant.plannedTime}` : ''}` +
              `${variant.timezone ? ` (${variant.timezone})` : ''} · это ориентир плана, не очередь публикации`};
          const postId = insert.run(owner.id, day.topic, variant.text, timezone, profile.revision,
            time, time, actorId, ORIGIN, JSON.stringify(meta), ++order).lastInsertRowid;
          link.run(owner.id, day.ideaId, platform, variant.contentRevision, body.planRevision,
            body.briefRevision, day.date, variant.plannedDate || '', variant.plannedTime || '',
            variant.timezone || '', variant.assetId || '', postId, time, actorId, actorName);
          created.push({ideaId: day.ideaId, platform, contentRevision: variant.contentRevision, postId});
        }
      }
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    return {companyCode: String(code).toLowerCase(), planRevision: body.planRevision,
      briefRevision: body.briefRevision, created, skipped,
      createdCount: created.length, alreadyTransferred: skipped.length,
      posts: created.map((item) => autoposting.get(item.postId, code)),
      notice: VARIANT_NOTICE, leavesUnfilled: MISSING, createsPublications: false,
      ideas: created.map((item) => ({...item, topic: ideas.get(item.ideaId)?.topic || ''}))};
  }

  return {status, transfer, context, variantStatus, transferVariants,
    TRANSFER_NOTICE: NOTICE, VARIANT_TRANSFER_NOTICE: VARIANT_NOTICE};
}

module.exports = {createMediaMentorTransfer, MEDIA_MENTOR_TRANSFER_NOTICE: NOTICE,
  MEDIA_MENTOR_TRANSFER_ORIGIN: ORIGIN, MEDIA_MENTOR_TRANSFER_MISSING: MISSING,
  MEDIA_MENTOR_TRANSFER_REPEAT_SCOPE: REPEAT_SCOPE,
  MEDIA_MENTOR_TRANSFER_NEW_VERSION_NOTICE: NEW_VERSION_NOTICE,
  MEDIA_MENTOR_MATERIAL_UPLOAD_PATH: MATERIAL_UPLOAD_PATH,
  MEDIA_MENTOR_MATERIAL_NOTICE: MATERIAL_NOTICE};
