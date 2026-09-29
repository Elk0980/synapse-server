'use strict';
/* Адаптеры сбора статистики соцсетей. Контракт: describe(platform, account) → {status, missing[]} без сетевых вызовов;
   collect({platform, account, date, timezone}) → {status: ok|partial|missing_access|unsupported, snapshots[], posts[], missing[]}.
   Статусы честные: без ключей/прав — missing_access с точным списком, что недостаёт. Ничего не публикуется, ключи не выводятся. */
/* Что недостаёт для сбора — общие шаблоны без клиентских идентификаторов; конкретный аккаунт подставляется из настроек компании ({account}). */
const NEED = Object.freeze({
  instagram: ['Meta-приложение Synapse и App Review для instagram_basic + instagram_manage_insights', 'токен профессионального аккаунта Instagram {account}, выданный владельцем', 'решение владельца о подключении (новые права)'],
  tiktok: ['TikTok for Developers: приложение, аудит, scope user.info.stats и video.list', 'OAuth-авторизация аккаунта TikTok {account} владельцем', 'решение владельца о подключении (новые права)'],
  youtube: ['Google Cloud проект с YouTube Analytics API и YouTube Data API', 'OAuth канала YouTube {account} (yt-analytics.readonly, youtube.readonly) владельцем', 'решение владельца о подключении (новые права)'],
  vk: ['ключ пользователя/сообщества с правом stats для сообщества {account} в подключении ВКонтакте (Автопостинг → Подключение площадок)'],
  telegram: ['бот из подключения Telegram должен быть администратором канала {account}; Bot API даёт только число подписчиков, просмотры постов недоступны без MTProto/канальной статистики'],
});
const scopedNeed = (platform, account) => { const ref = String(account?.account_ref || '').trim() || 'из настроек аналитики'; return (NEED[platform] || ['адаптер не реализован']).map((line) => line.replace('{account}', ref)); };
/* Чего недостаёт для сбора через Onlypult Analytics. Это REST по Bearer-ключу кабинета,
   а не MCP и не OAuth 2.1: прежняя формулировка про обязательный MCP OAuth и несуществующий
   ключ устарела и вводила в заблуждение. */
const ONLYPULT_NEED = ['аналитический ключ доступа кабинета Onlypult, сохранённый отдельно от ключа публикаций',
  'аналитический профиль Onlypult (an_…), подключённый к нужному аккаунту площадки',
  'подтверждённые самим профилем разделы (overview) и дневная детализация',
  'Onlypult Analytics не покрывает ВКонтакте, Telegram, YouTube, 2ГИС и MAX — для них нужен отдельный источник'];
const { dayBounds } = require('./social-stats');
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/* analytics — отдельный аналитический доступ и сборщик Onlypult Analytics.
   Он инъекцией, а не импортом подключения публикаций: у аналитики свой ключ, своя ревизия
   и свой список профилей, и перепутать их нельзя. Без инъекции адаптер честно говорит,
   что подключения нет, и чисел не выдумывает. */
function createSocialAdapters({ transport, analytics = null, channelStats = null, env = process.env, now = () => Date.now() } = {}) {
  /* Отдельный путь для Telegram: текущий счётчик подписчиков через уже работающего бота
     Synapse. Он не зависит от того, чем ведутся ПУБЛИКАЦИИ: строка аккаунта может быть
     onlypult, а счётчик всё равно снимается. Подключения публикаций это не трогает.
     Просмотры и реакции постов Bot API не отдаёт — и здесь их не появляется. */
  const CHANNEL_NOTE = 'регулярный счётчик подписчиков канала через существующего бота Synapse; просмотры и реакции постов через Bot API недоступны';
  const channelReady = () => Boolean(channelStats?.channelMembers && channelStats.ready !== false);
  async function telegramChannel({ company, account }) {
    if (!channelReady()) return null;
    const ref = String(account?.account_ref || '').trim();
    // Аккаунт без явно указанного канала не угадывается.
    if (!ref) return { status: 'missing_access', missing: ['в аккаунте аналитики не указан канал: угадывать его нельзя', CHANNEL_NOTE] };
    let answer;
    try { answer = await channelStats.channelMembers(company.code); }
    catch (error) {
      /* Отказ по привязке — окончательный: канал не подтверждён, и запасной путь его не
         подтвердит. Ненастроенный или неотвечающий сервис — временная причина, при ней
         прежний прямой путь через подключение площадки остаётся доступен. */
      const decisive = ['NO_BINDING', 'UNSUPPORTED_LINK', 'BINDING_CHANGED', 'COMPANY_MISMATCH', 'BAD_RESPONSE', 'REJECTED'];
      if (decisive.includes(error?.code))
        return { status: 'missing_access', hard: true,
          missing: [`счётчик подписчиков не снят: ${error?.message || 'отказ сервиса'}`, CHANNEL_NOTE] };
      /* Временная причина (сервис не ответил, адрес не настроен) — НЕ missing_access:
         такой статус закрывает дату от повторов, и восстановившийся сервис уже не спросили
         бы до следующих суток. failed оставляет дату в очереди повторов. */
      return { status: 'failed', temporary: true,
        error: `счётчик подписчиков не снят: ${error?.message || 'сервис не ответил'}`,
        missing: [`счётчик подписчиков временно недоступен: ${error?.message || 'сервис не ответил'}`, CHANNEL_NOTE] };
    }
    /* hard — ответ пришёл, но он относится не к нам. Это окончательный отказ: подменять его
       запасным путём нельзя, иначе расхождение привязки осталось бы незамеченным. */
    if (String(answer.companyCode).toLowerCase() !== String(company.code).toLowerCase())
      return { status: 'missing_access', hard: true, missing: ['ответ счётчика относится к другой компании: значение не записано'] };
    /* Сверка с сохранённым аккаунтом: @имя и -100… — разные записи одного канала, но
       подтвердить их тождество нечем, поэтому расхождение останавливает запись. */
    const same = ref.replace(/^@/, '').toLowerCase() === String(answer.accountRef).replace(/^@/, '').toLowerCase();
    if (!same) return { status: 'missing_access', hard: true,
      missing: [`канал компании (${answer.accountRef}) не совпадает с сохранённым в аккаунте аналитики (${ref}): значение не записано`] };
    return { status: 'partial',
      /* Текущее число — состояние на момент наблюдения. historical здесь не ставится:
         снимок датируется днём наблюдения, а не целевой датой backfill. */
      snapshots: [{ period: 'lifetime', metric: 'followers', value: answer.value,
        sourceField: 'getChatMemberCount', kind: account.kind, completeness: 'complete' }],
      missing: ['просмотры и реакции постов: Bot API их не отдаёт'],
      provenance: { accountRef: answer.accountRef, observedAt: answer.observedAt || null, source: answer.source } };
  }
  const direct = {
    info: () => ({ name: 'direct', available: Boolean(transport), note: 'Прямые API площадок через сохранённые подключения; Instagram/TikTok/YouTube требуют собственных приложений и разрешений владельца.' }),
    // Отпечаток подключения площадки (ревизия/цель, без токена): сравнивается до и после сетевого вызова.
    connectionRevision({ company, platform, account }) {
      /* Счётчик канала опирается на компанию и сохранённый канал. Но при временной
         недоступности счётчика сбор уходит на прежний путь через подключение площадки —
         значит ревизия ЭТОГО подключения из отпечатка выпадать не должна, иначе смена
         токена во время запроса осталась бы незамеченной и старое число записалось бы. */
      if (platform === 'telegram' && channelReady()) {
        const own = `telegram_channel:${String(company?.code || '').toLowerCase()}:${account?.account_ref || ''}`;
        if (typeof transport?.connectionRevision !== 'function') return own;
        const info = transport.connectionRevision(company.code, platform);
        return `${own}|${info ? `${info.provider}:${info.revision}:${info.target}` : 'none'}`;
      }
      if (platform !== 'telegram' && platform !== 'vk' || !transport?.connectionRevision) return null;
      const info = transport.connectionRevision(company.code, platform);
      return info ? `${info.provider}:${info.revision}:${info.target}` : null;
    },
    describe(platform, account) {
      if (platform === 'telegram') {
        if (channelReady() && account?.account_ref) return { status: 'depends_on_connection',
          missing: ['подтверждённая ссылка на публичный канал в карточке компании (поле telegram_channel)', 'бот Synapse — администратор канала'],
          note: `${CHANNEL_NOTE}. Наличие настройки не означает, что счётчик уже снят: это проверяется при сборе.` };
        if (channelReady()) return { status: 'missing_access',
          missing: ['в аккаунте аналитики не указан канал', CHANNEL_NOTE] };
        return { status: 'depends_on_connection', missing: scopedNeed(platform, account), note: 'Проверяется при сборе по сохранённому подключению площадки.' };
      }
      if (platform === 'vk') return { status: 'depends_on_connection', missing: scopedNeed(platform, account), note: 'Проверяется при сборе по сохранённому подключению площадки.' };
      return { status: 'missing_access', missing: scopedNeed(platform, account) };
    },
    async collect({ company, platform, account, date, timezone, closed = true, dayStartMs, dayEndMs }) {
      const need = scopedNeed(platform, account);
      if (platform !== 'telegram' && platform !== 'vk') return { status: 'missing_access', missing: need };
      /* Счётчик канала идёт первым и не требует сохранённого подключения площадки.
         Прежний прямой путь через подключение сохраняется как запасной. */
      let temporary = null;
      if (platform === 'telegram' && channelReady()) {
        const channel = await telegramChannel({ company, account });
        /* Запасной прямой путь через подключение площадки остаётся только для случаев,
           когда счётчик просто не настроен или временно не ответил. Расхождение привязки
           им не заслоняется. */
        if (channel && channel.temporary && transport?.readStats) temporary = channel;
        else if (channel && (channel.status !== 'missing_access' || channel.hard || !transport?.readStats)) return channel;
      }
      /* Если временная причина была, а запасной путь тоже не дал чисел, наружу уходит
         повторяемый статус: дата остаётся в очереди, а не закрывается как «нет доступа». */
      const keepRetryable = (result) => (temporary && ['missing_access', 'unsupported'].includes(result.status)
        ? { status: 'failed', error: temporary.error, missing: [...temporary.missing, ...(result.missing || [])] }
        : result);
      if (!transport?.readStats) return { status: 'unsupported', missing: ['транспорт подключений недоступен'] };
      if (platform === 'telegram') {
        const chat = account.account_ref || undefined;
        let result;
        try { result = await transport.readStats(company.code, 'telegram', 'getChatMemberCount', chat ? { chat_id: chat } : {}); }
        catch (error) { return keepRetryable({ status: 'missing_access', missing: [`Telegram отклонил запрос (${error?.code || 'ошибка'}): ${need[0]}`] }); }
        if (!result) return keepRetryable({ status: 'missing_access', missing: ['подключение Telegram (токен бота) не сохранено', ...need] });
        if (result.unsupported) return keepRetryable({ status: 'unsupported', missing: [`подключение Telegram через ${result.provider} не даёт статистики; нужен прямой бот`] });
        if (!chat && !result.target) return keepRetryable({ status: 'missing_access', missing: ['не указан канал (@имя или -100…) ни в аккаунте аналитики, ни в подключении'] });
        const count = num(result.result);
        if (count === null) return { status: 'failed', error: 'Telegram вернул не число подписчиков' };
        return { status: 'partial', snapshots: [{ date, period: 'lifetime', metric: 'followers', value: count, sourceField: 'getChatMemberCount', kind: account.kind, completeness: 'complete' }],
          missing: ['просмотры и реакции постов: Bot API их не отдаёт'] };
      }
      if (platform === 'vk') {
        const group = String(account.account_ref || '').replace(/^club/, '').replace(/^-/, '');
        let members, stats;
        try { members = await transport.readStats(company.code, 'vk', 'groups.getById', { group_id: group || undefined, fields: 'members_count' }); }
        catch (error) { return { status: 'missing_access', missing: [`ВКонтакте отклонил запрос (${error?.code || 'ошибка'})`, ...need] }; }
        if (!members) return { status: 'missing_access', missing: ['подключение ВКонтакте (ключ) не сохранено', ...need] };
        if (members.unsupported) return { status: 'unsupported', missing: [`подключение ВКонтакте через ${members.provider} не даёт статистики; нужен прямой ключ`] };
        const info = Array.isArray(members.result?.groups) ? members.result.groups[0] : Array.isArray(members.result) ? members.result[0] : members.result;
        const snapshots = [];
        if (num(info?.members_count) !== null) snapshots.push({ date, period: 'lifetime', metric: 'followers', value: info.members_count, sourceField: 'groups.getById.members_count', kind: account.kind, completeness: 'complete' });
        const missing = [];
        // Границы суток — реальные границы локального дня аккаунта (его timezone), а не фиксированный +07:00.
        const bounds = Number.isFinite(dayStartMs) && Number.isFinite(dayEndMs) ? { startMs: dayStartMs, endMs: dayEndMs } : dayBounds(date, timezone || 'Asia/Bangkok');
        const dayStart = Math.floor(bounds.startMs / 1000), dayEnd = Math.floor(bounds.endMs / 1000) - 1;
        try { stats = await transport.readStats(company.code, 'vk', 'stats.get', { group_id: group || info?.id, timestamp_from: dayStart, timestamp_to: dayEnd, interval: 'day', stats_groups: 'visitors,reach,activity' }); }
        catch (error) { stats = null; missing.push(`stats.get недоступен (${error?.code || 'ошибка'}): ${need[0]}`); }
        const entry = Array.isArray(stats?.result) ? stats.result[0] : null;
        if (entry) {
          const map = [['views', entry.visitors?.views, 'visitors.views'], ['reach', entry.reach?.reach, 'reach.reach'], ['likes', entry.activity?.likes, 'activity.likes'],
            ['comments', entry.activity?.comments, 'activity.comments'], ['shares', entry.activity?.copies, 'activity.copies'], ['follower_change', num(entry.activity?.subscribed) !== null && num(entry.activity?.unsubscribed) !== null ? entry.activity.subscribed - entry.activity.unsubscribed : null, 'activity.subscribed-unsubscribed']];
          for (const [metric, value, field] of map) if (num(value) !== null) snapshots.push({ date, period: 'day', metric, value, sourceField: field, kind: account.kind, completeness: closed ? 'complete' : 'partial' });
        }
        if (!snapshots.length) return { status: 'missing_access', missing: missing.length ? missing : need };
        return { status: entry ? 'ok' : 'partial', snapshots, missing };
      }
      return { status: 'missing_access', missing: need };
    },
  };
  /* Onlypult Analytics: реальный сбор по REST для Instagram и TikTok.
     Остальные пять площадок семи — не «пока не настроены», а не покрываются этим источником:
     для них unsupported, а не missing_access, и существующие отдельные источники не трогаются. */
  const ONLYPULT_PLATFORMS = ['instagram', 'tiktok'];
  const analyticsReady = () => Boolean(analytics?.collector && analytics?.credentials);
  const onlypult = {
    /* Onlypult правит историю задним числом: закрытые сутки недавнего окна нужно перепроверять,
       иначе исправленное значение к нам не доедет. У прямых подключений такого поведения нет. */
    revisesHistory: true,
    info: () => ({ name: 'onlypult', available: analyticsReady(), temporary: false,
      note: analyticsReady()
        ? 'Onlypult Analytics по REST: Instagram и TikTok по аналитическим профилям an_…; ВКонтакте, Telegram, YouTube, 2ГИС и MAX этот источник не покрывает.'
        : 'Onlypult Analytics не подключён: аналитический доступ и профиль an_… не сохранены.' }),
    // describe сети не касается: только сохранённое состояние доступа и выбранного профиля.
    describe(platform, account) {
      /* Публикации Telegram могут идти через Onlypult — счётчик подписчиков это не
         отменяет: он снимается отдельным путём через бота Synapse и публикаций не касается. */
      if (platform === 'telegram' && channelReady()) return direct.describe('telegram', account);
      if (!ONLYPULT_PLATFORMS.includes(platform))
        return { status: 'unsupported', missing: [ONLYPULT_NEED[3]] };
      if (!analyticsReady()) return { status: 'missing_access', missing: ONLYPULT_NEED };
      let access = null;
      try { access = analytics.credentials.get(account?.company_code || account?.companyCode || ''); } catch { access = null; }
      if (!access?.configured) return { status: 'missing_access', missing: [ONLYPULT_NEED[0], ONLYPULT_NEED[1]] };
      if (!account?.provider_ref) return { status: 'missing_access', missing: ['выбранный аналитический профиль Onlypult (an_…) для этого аккаунта'] };
      if (!account?.account_ref) return { status: 'missing_access', missing: ['подтверждённый идентификатор аккаунта площадки (native ID) выбранного профиля'] };
      return { status: access.checked ? 'ok' : 'unchecked', missing: access.checked ? [] : ['проверка аналитического доступа не выполнена после последнего изменения ключа'] };
    },
    /* Отпечаток аналитической привязки: ревизия доступа плюс профиль, native ID и система
       суток. Контракт вызова — один объект контекста, как у прямого адаптера. */
    connectionRevision({ company, account, platform } = {}) {
      /* У счётчика канала своя привязка: компания и сохранённый канал. Аналитический доступ
         Onlypult к нему отношения не имеет, поэтому и отпечаток другой. */
      if (platform === 'telegram' && channelReady())
        return { provider: 'telegram_channel', companyCode: String(company?.code || '').toLowerCase(), accountRef: account?.account_ref || '' };
      if (!analyticsReady()) return null;
      const code = company?.code || account?.company_code || '';
      if (!code) return null;
      let access = null;
      try { access = analytics.credentials.connectionRevision(code); } catch { return null; }
      if (!access) return null;
      return { revision: access.revision, provider: 'onlypult_analytics',
        providerRef: account?.provider_ref || '', accountRef: account?.account_ref || '', timezone: account?.timezone || '' };
    },
    async collect({ company, platform, account, date, timezone, companyCode }) {
      const code = company?.code || companyCode || account?.company_code || account?.companyCode || '';
      // Счётчик подписчиков канала не зависит от того, чем ведутся публикации.
      if (platform === 'telegram' && channelReady()) return telegramChannel({ company: { code }, account });
      if (!ONLYPULT_PLATFORMS.includes(platform)) return { status: 'unsupported', missing: [ONLYPULT_NEED[3]] };
      const ready = onlypult.describe(platform, { ...account, company_code: code });
      if (['missing_access', 'unsupported'].includes(ready.status)) return { status: ready.status, missing: ready.missing };
      const before = onlypult.connectionRevision({ company: { code }, account });
      let result;
      try {
        /* Профиль берётся из настоящего списка источника, а не собирается здесь.
           Синтетический профиль с пустыми capabilities — это обход проверки: у него нет
           ни подтверждённой платформы, ни подтверждённого native ID, ни разрешённых разделов. */
        const listing = await analytics.collector.listProfiles(code);
        const profile = (listing.profiles || []).find((item) => item.id === account.provider_ref);
        if (!profile) return { status: 'missing_access',
          missing: [`аналитический профиль ${account.provider_ref} не найден в списке источника: выберите профиль заново`] };
        if (profile.platform !== platform) return { status: 'missing_access',
          missing: [`аналитический профиль ${account.provider_ref} относится к другой площадке (${profile.platform})`] };
        if (String(profile.nativeAccountId) !== String(account.account_ref)) return { status: 'missing_access',
          missing: ['идентификатор аккаунта площадки у профиля не совпадает с сохранённым: сбор остановлен'] };
        result = await analytics.collector.collectDay({ companyCode: code, profile,
          from: date, to: date, timezone: timezone || account.timezone || undefined });
      } catch (error) {
        // Причина отказа честная и без чисел; ключ в сообщение не попадает.
        return { status: error?.code === 'UNSUPPORTED' ? 'unsupported' : 'missing_access',
          missing: [`Onlypult Analytics: ${error?.code || 'ошибка запроса'}`] };
      }
      const after = onlypult.connectionRevision({ company: { code }, account });
      /* Привязка проверяется до и после запроса: если доступ, профиль, аккаунт или часовой
         пояс сменились, пока шёл GET, результат относится к другой системе — не записываем. */
      if (JSON.stringify(before) !== JSON.stringify(after))
        return { status: 'missing_access', missing: ['аналитическая привязка изменилась во время запроса: результат не записан'] };
      if (result.status === 'unsupported') return { status: 'unsupported', missing: result.missing };
      /* Исходные блоки ответа передаются наверх ВСЕГДА, независимо от того, вышел ли из
         них хоть один показатель. Иначе кандидатный график, итог источника и null-ряд
         терялись здесь и в доказательства не попадали: ответ был, а следа не осталось. */
      return { status: result.status, snapshots: result.measurements || [], posts: [], missing: result.missing || [],
        provenance: { providerRef: account.provider_ref, nativeAccountId: account.account_ref,
          coverage: result.coverage, warnings: result.warnings, period: result.period,
          mappingVersion: result.mappingVersion, catalogVersion: result.catalogVersion,
          accessRevision: result.accessRevision, identityConfirmed: result.identityConfirmed === true,
          projectable: result.projectable !== false, blocks: result.blocks || [] } };
    },
  };
  const manual = {
    info: () => ({ name: 'manual', available: true, note: 'Ручной ввод реальных чисел из кабинета площадки с датой снятия и источником; не заменяет живой сбор.' }),
    describe() { return { status: 'manual', missing: ['автоматический сбор не ведётся: числа вносит владелец с датой снятия'] }; },
  };
  return { direct, onlypult, manual };
}
module.exports = { createSocialAdapters, NEED, ONLYPULT_NEED, scopedNeed };
