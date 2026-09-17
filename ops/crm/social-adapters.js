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
const ONLYPULT_NEED = ['аналитические профили Onlypult (an_…) отдельно от профилей публикаций', 'подключение Onlypult MCP Analytics по OAuth 2.1 (в Onlypult ключ API/MCP не создан)',
  'подтверждённый e-mail кабинета Onlypult', 'Onlypult Analytics не покрывает ВКонтакте, Telegram и YouTube — для них нужен прямой путь'];
const { dayBounds } = require('./social-stats');
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function createSocialAdapters({ transport, env = process.env, now = () => Date.now() } = {}) {
  const direct = {
    info: () => ({ name: 'direct', available: Boolean(transport), note: 'Прямые API площадок через сохранённые подключения; Instagram/TikTok/YouTube требуют собственных приложений и разрешений владельца.' }),
    // Отпечаток подключения площадки (ревизия/цель, без токена): сравнивается до и после сетевого вызова.
    connectionRevision({ company, platform }) {
      if (platform !== 'telegram' && platform !== 'vk' || !transport?.connectionRevision) return null;
      const info = transport.connectionRevision(company.code, platform);
      return info ? `${info.provider}:${info.revision}:${info.target}` : null;
    },
    describe(platform, account) {
      if (platform === 'telegram' || platform === 'vk') return { status: 'depends_on_connection', missing: scopedNeed(platform, account), note: 'Проверяется при сборе по сохранённому подключению площадки.' };
      return { status: 'missing_access', missing: scopedNeed(platform, account) };
    },
    async collect({ company, platform, account, date, timezone, closed = true, dayStartMs, dayEndMs }) {
      const need = scopedNeed(platform, account);
      if (platform !== 'telegram' && platform !== 'vk') return { status: 'missing_access', missing: need };
      if (!transport?.readStats) return { status: 'unsupported', missing: ['транспорт подключений недоступен'] };
      if (platform === 'telegram') {
        const chat = account.account_ref || undefined;
        let result;
        try { result = await transport.readStats(company.code, 'telegram', 'getChatMemberCount', chat ? { chat_id: chat } : {}); }
        catch (error) { return { status: 'missing_access', missing: [`Telegram отклонил запрос (${error?.code || 'ошибка'}): ${need[0]}`] }; }
        if (!result) return { status: 'missing_access', missing: ['подключение Telegram (токен бота) не сохранено', ...need] };
        if (result.unsupported) return { status: 'unsupported', missing: [`подключение Telegram через ${result.provider} не даёт статистики; нужен прямой бот`] };
        if (!chat && !result.target) return { status: 'missing_access', missing: ['не указан канал (@имя или -100…) ни в аккаунте аналитики, ни в подключении'] };
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
  const onlypult = {
    info: () => ({ name: 'onlypult', available: false, temporary: true, note: 'Временный источник: Onlypult MCP Analytics (OAuth 2.1, профили an_…). Подключение не создано.' }),
    describe(platform) { return { status: 'missing_access', missing: ['vk', 'telegram', 'youtube'].includes(platform) ? [ONLYPULT_NEED[3]] : ONLYPULT_NEED }; },
    async collect({ platform }) {
      // Мост к MCP Analytics отсутствует: без OAuth-подключения сбор невозможен; заглушек с цифрами нет.
      return { status: ['vk', 'telegram', 'youtube'].includes(platform) ? 'unsupported' : 'missing_access', missing: ['vk', 'telegram', 'youtube'].includes(platform) ? [ONLYPULT_NEED[3]] : ONLYPULT_NEED };
    },
  };
  const manual = {
    info: () => ({ name: 'manual', available: true, note: 'Ручной ввод реальных чисел из кабинета площадки с датой снятия и источником; не заменяет живой сбор.' }),
    describe() { return { status: 'manual', missing: ['автоматический сбор не ведётся: числа вносит владелец с датой снятия'] }; },
  };
  return { direct, onlypult, manual };
}
module.exports = { createSocialAdapters, NEED, ONLYPULT_NEED, scopedNeed };
