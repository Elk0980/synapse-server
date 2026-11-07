'use strict';

// Contract: https://onlypult.com/dev/openapi.yaml, inspected 2026-09-17, rechecked 2026-11-07.
// Post has id/status/profile_ids; its schema DOES NOT document a published URL.
/* Решение Влада 07.11 (specs/215-publish-verify, FR-3): выход подтверждает ПОВТОРНОЕ чтение задания
   (GET /posts/{id}) со статусом published — ответ на отправку его не подтверждает. Ссылка на конкретный
   пост берётся только из аналитики Onlypult (permalink ниже) и только для Instagram/TikTok; иначе url пустой. */
const BASE = 'https://api.onlypult.com/v1';
// Onlypult's live response on 2026-09-17 uses "vk"; OpenAPI documents "vkontakte".
/* Соответствие площадок Synapse значениям Profile.platform у Onlypult.
   Значения для instagram/tiktok/max взяты из проверенной OpenAPI (29.09.2026), не из догадок:
   у Instagram два варианта входа, оба означают бизнес-профиль. */
const PLATFORM = {vk:['vkontakte','vk'],telegram:['telegram'],youtube_shorts:['youtube'],
  instagram:['instagram_business_login','instagram_business'],tiktok:['tiktok'],max:['max']};
/* Ключ platform_options и закрытый список полей, которые Onlypult принимает для этой площадки.
   Опции одной площадки никогда не уходят другой: отправляется только ключ своей площадки. */
const OPTION_KEY = {instagram:'instagram',tiktok:'tiktok',max:'max'};
const OPTION_FIELDS = {
  instagram:['is_story','is_reels','disable_comment'],
  tiktok:['privacy','disable_comment','disable_duet','disable_stitch'],
  max:['pin_message'],
};
// Канал YouTube Shorts: заголовок обязателен, ровно один публичный HTTPS-видеофайл.
// Категорию не отправляем: она опциональна и её идентификаторы берутся из отдельного запроса профиля.
/* Единое правило ссылки на видео для YouTube Shorts во всех трёх проверках (кабинет, сервер, адаптер):
   разбирается как URL, схема только https, фрагмент пуст, расширение проверяется именно в пути.
   Поэтому jpg?name=.mp4 видео не считается, clip.mp4?version=1 проходит, clip.mp4#t=1 отклоняется. */
function isVideoUrl(value) {
  if (typeof value !== 'string' || !value) return false;
  let url;
  try {url = new URL(value);} catch {return false;}
  return url.protocol === 'https:' && url.hash === '' && /\.(mp4|mov|m4v|webm)$/i.test(url.pathname);
}
// Похоже на видео по расширению пути, даже если ссылка с фрагментом: такой файл в довесок к фото не уходит.
const looksLikeVideo = value => {try {return /\.(mp4|mov|m4v|webm)$/i.test(new URL(value).pathname);} catch {return false;}};
const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value);
/* Instagram Story без подписи. Контракт https://onlypult.com/dev/openapi.yaml (OpenAPI 3.0.3, info.version 1.0.0,
   проверен root 30.09.2026): PostCreateRequest.required = [profile_ids]; content — string без minLength,
   «Required unless media_ids or media_urls is provided». PlatformSettings.is_story — Story для Instagram,
   несовместим с is_reels/is_shorts. Поэтому при материале и пустом тексте content не отправляется вовсе. */
// Поиск задания без идентификатора: страница списка и предел страниц (не больше 1000 заданий профиля за один поиск).
const SEARCH_LIMIT = 100, SEARCH_PAGES = 10;
function createOnlypultProvider({failure,readResponse,fetchImpl,tokenFor}) {
  async function request(row,method,path,body,{whole = false} = {}) {
    const token = tokenFor(row), mutation = method !== 'GET';
    let response,data;
    try {
      const signal = AbortSignal.timeout(20000);
      response = await fetchImpl(BASE + path,{method,redirect:'error',signal,
        headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},
        ...(body ? {body:JSON.stringify(body)} : {})});
      data = JSON.parse(await readResponse(response,signal));
    } catch {throw failure('CONNECTION_UNCERTAIN',mutation);}
    if (!response.ok) {
      // Only a documented, parsed rejection establishes that creation failed.
      const rejected = data && typeof data === 'object' && !Array.isArray(data) &&
        (([400,401,403,404,429].includes(response.status) && data.status === response.status && Number.isInteger(data.code)) ||
         (response.status === 422 && typeof data.error?.code === 'string' && typeof data.error?.retryable === 'boolean'));
      if (rejected) {
        // Код ответа и признак retryable нужны отправке: отличить «точно не создано» от «могло создаться».
        const error = failure([401,403].includes(response.status) ? 'ACCESS_DENIED' : 'PLATFORM_REJECTED');
        error.httpStatus = response.status;
        if (response.status === 422) error.retryable = data.error.retryable;
        throw error;
      }
      throw failure('CONNECTION_UNCERTAIN',mutation);
    }
    if (!data || typeof data !== 'object' || !Object.hasOwn(data,'data')) throw failure('RESPONSE_UNCERTAIN',mutation);
    return whole ? data : data.data;
  }
  async function inspectProfiles(row) {
    const profiles = await request(row,'GET','/profiles');
    if (!Array.isArray(profiles) || profiles.length > 1000) throw failure('RESPONSE_UNCERTAIN');
    const counts = new Map(), shapes = new Map();
    let otherShapesCount = 0;
    const fieldType = value => value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
    for (const profile of profiles) {
      const platform = typeof profile?.platform === 'string' && /^[a-z][a-z0-9_-]{0,39}$/.test(profile.platform) ? profile.platform : 'unknown';
      counts.set(platform,(counts.get(platform) || 0) + 1);
      const shape = {idType:fieldType(profile?.id),nameType:fieldType(profile?.name),statusType:fieldType(profile?.status),platformType:fieldType(profile?.platform)};
      if (profile?.platform === undefined) shape.fieldNames = profile && typeof profile === 'object' && !Array.isArray(profile)
        ? Object.keys(profile).filter(key => /^[a-z_]{1,30}$/.test(key)).sort().slice(0,20) : [];
      const key = JSON.stringify(shape), previous = shapes.get(key);
      if (previous) previous.count++;
      else if (shapes.size < 20) shapes.set(key,{...shape,count:1});
      else otherShapesCount++;
    }
    const matching = profiles.filter(profile => PLATFORM[row.id]?.includes(profile?.platform)).map(profile => {
      if (!id(profile.id) || typeof profile.name !== 'string' || typeof profile.status !== 'string') throw failure('RESPONSE_UNCERTAIN');
      // Never return raw provider objects (credentials/private fields may be added later).
      return {id:profile.id,name:profile.name.slice(0,200),platform:row.id,status:profile.status.slice(0,60),
        username:typeof profile.username === 'string' ? profile.username.slice(0,120) : null};
    });
    return {profiles:matching,diagnostics:{totalProfiles:profiles.length,
      platformCounts:Array.from(counts,([platform,count]) => ({platform,count})).sort((a,b) => a.platform.localeCompare(b.platform)),
      profileShapes:Array.from(shapes.values()),otherShapesCount}};
  }
  async function listProfiles(row) {return (await inspectProfiles(row)).profiles;}
  async function check(row) {
    if (!id(row.target)) throw failure('PROFILE_REQUIRED');
    const profiles = await listProfiles(row), matches = profiles.filter(profile => profile.id === row.target);
    if (matches.length !== 1) throw failure('PROFILE_NOT_FOUND');
    if (matches[0].status !== 'active') throw failure('PROFILE_INACTIVE');
    return matches[0];
  }
  /* Профиль в ответе. Документированный контракт — profile_ids:string[]; живой ответ присылает
     одиночный числовой profile_id. Поддерживаются оба, строго: строковый идентификатор берётся как есть,
     числовой принимается только как безопасное положительное целое и приводится к каноничной строке.
     Присутствуют оба — обязаны совпадать. Всё остальное — неизвестный ответ. */
  function profileOf(data) {
    let fromList=null,fromSingle=null;
    if (Object.hasOwn(data,'profile_ids')) {
      if (!Array.isArray(data.profile_ids) || data.profile_ids.length !== 1 || !id(data.profile_ids[0])) return null;
      fromList = data.profile_ids[0];
    }
    if (Object.hasOwn(data,'profile_id')) {
      const value = data.profile_id;
      // Явный null рядом со списком — неполный, противоречивый ответ, а не «поля нет».
      if (value === null) return null;
      if (typeof value === 'string') {if (!id(value)) return null;fromSingle = value;}
      else if (Number.isSafeInteger(value) && value > 0) fromSingle = String(value);
      else return null;
    }
    if (fromList && fromSingle && fromList !== fromSingle) return null;
    // Новый формат опознаётся по одиночному profile_id, и площадка в нём обязательна.
    if (fromSingle && !fromList && !Object.hasOwn(data,'platform')) return null;
    return fromList || fromSingle;
  }
  function receipt(data,row,expectedId) {
    const profile = data && typeof data === 'object' && !Array.isArray(data) ? profileOf(data) : null;
    // Площадка названа — сверяем точно. Ответ без неё допустим только при строгом совпадении профиля.
    const platformNamed = data && Object.hasOwn(data,'platform');
    if (platformNamed && !PLATFORM[row.id]?.includes(data.platform)) throw failure('RESPONSE_UNCERTAIN',true);
    if (!data || !id(data.id) || (expectedId && data.id !== expectedId) ||
        !profile || profile !== row.target ||
        !['draft','scheduled','published','failed'].includes(data.status)) throw failure('RESPONSE_UNCERTAIN',true);
    // Время выхода — только корректная дата провайдера; иначе null, не выдумывается.
    const at = typeof data.published_at === 'string' && !Number.isNaN(Date.parse(data.published_at)) ? new Date(Date.parse(data.published_at)).toISOString() : null;
    return {provider:'onlypult',providerPostId:data.id,providerStatus:data.status,status:'needs_review',publishedAt:data.status === 'published' ? at : null,
      errorCode:data.status === 'published' ? 'PROVIDER_LINK_UNAVAILABLE' : data.status === 'failed' ? 'PROVIDER_FAILED' : 'PROVIDER_PENDING'};
  }
  async function publish(row,post,guard) {
    await check(row);guard();
    const account = await request(row,'GET','/account');guard();
    if (account?.plan_active !== true) throw failure('PROVIDER_PLAN_INACTIVE');
    const limits = await request(row,'GET',`/posts/limits?profile_id=${encodeURIComponent(row.target)}`);guard();
    /* Ограничения берутся у конкретного профиля и применяются целиком. Отсутствующие и нулевые
       значения запретом не считаются и не заменяются выдуманными: проверяется только то, что
       профиль действительно сообщил. Режим Story задаёт СВОЙ максимум вложений и заменяет
       обычный maxCount, а не проверяется после него. */
    const media = limits?.platform?.limits?.media, textLimits = limits?.platform?.limits?.text;
    const positive = value => Number.isInteger(value) && value > 0;
    const chosenRaw = (post.platformOptions && typeof post.platformOptions === 'object' && !Array.isArray(post.platformOptions)
      ? post.platformOptions[row.id] : null) || null;
    const storyMode = row.id === 'instagram' && chosenRaw?.is_story === true;
    const maxMedia = storyMode && positive(media?.maxCountStory) ? media.maxCountStory : media?.maxCount;
    if (positive(textLimits?.charLimit) && post.text.length > textLimits.charLimit) throw failure('CONTENT_LIMIT');
    if (positive(maxMedia) && post.mediaUrls.length > maxMedia) throw failure('CONTENT_LIMIT');
    /* Нижняя граница вложений профиля относится к обычной публикации: отдельного минимума
       для Story контракт не задаёт, и переносить на неё минимум другого режима нельзя. */
    if (!storyMode && positive(media?.minCount) && post.mediaUrls.length < media.minCount) throw failure('CONTENT_LIMIT');
    // Хештеги и упоминания считаются в отправляемом тексте по подтверждённым лимитам профиля.
    const count = pattern => (post.text.match(pattern) || []).length;
    if (Number.isInteger(textLimits?.hashLimit) && textLimits.hashLimit >= 0 && count(/(?:^|[^\p{L}\p{N}_#])#[\p{L}\p{N}_]+/gu) > textLimits.hashLimit) throw failure('CONTENT_LIMIT');
    if (Number.isInteger(textLimits?.mentionsLimit) && textLimits.mentionsLimit >= 0 && count(/(?:^|[^\p{L}\p{N}_@])@[\p{L}\p{N}_.]+/gu) > textLimits.mentionsLimit) throw failure('CONTENT_LIMIT');
    const extra = {};
    /* Опции берутся только из сохранённой и согласованной версии карточки и только своей площадки.
       Пустой объект не отправляется: молчаливых умолчаний у площадки быть не должно. */
    const chosen = (post.platformOptions && typeof post.platformOptions === 'object' && !Array.isArray(post.platformOptions)
      ? post.platformOptions[row.id] : null) || null;
    if (chosen !== null && (typeof chosen !== 'object' || Array.isArray(chosen))) throw failure('CONTENT_LIMIT');
    if (OPTION_KEY[row.id]) {
      const allowed = OPTION_FIELDS[row.id];
      const options = {};
      for (const [key, value] of Object.entries(chosen || {})) {
        if (!allowed.includes(key)) throw failure('CONTENT_LIMIT');
        options[key] = value;
      }
      if (row.id === 'instagram') {
        /* Story и Reel — разные режимы, и пределы одного на другой не переносятся.
           Reel — это ровно одно вложение, и оно видео: фото «в довесок» к ролику не уходит. */
        if (options.is_story === true && options.is_reels === true) throw failure('CONTENT_LIMIT');
        if (options.is_reels === true && (post.mediaUrls.length !== 1 || !isVideoUrl(post.mediaUrls[0]))) throw failure('CONTENT_LIMIT');
        if (!post.mediaUrls.length) throw failure('CONTENT_LIMIT');
      }
      /* TikTok. Режим доступа выбирает владелец в карточке, без умолчаний. Решение Влада 06.11:
         публикуем выбранный режим. Если профилю он недоступен, TikTok/Onlypult отклоняет пост
         ошибкой — это видно в журнале, «тихой» подмены режима нет. Опубликованность
         подтверждается только повторным чтением поста, а не ответом API. */
      if (row.id === 'tiktok') {
        if (!['PUBLIC_TO_EVERYONE', 'SELF_ONLY'].includes(options.privacy)) throw failure('TIKTOK_PRIVACY_REQUIRED');
        if (post.mediaUrls.filter(isVideoUrl).length !== 1 || post.mediaUrls.length !== 1) throw failure('CONTENT_LIMIT');
      }
      if (Object.keys(options).length) extra.platform_options = {[OPTION_KEY[row.id]]: options};
    } else if (chosen && Object.keys(chosen).length) {
      // Опции для площадки, у которой публикуемых опций нет, не отправляются вовсе.
      throw failure('CONTENT_LIMIT');
    }
    /* Telegram через Onlypult — «фото или одно видео»: до 10 фото либо ровно одно видео (рилс) с подписью.
       Видео вместе с фото или второе видео не отправляются. Контракт Onlypult (media_urls — «Public image/video
       URLs») видео для Telegram не запрещает, но и отдельно не описывает: живой отправкой не подтверждено. */
    if (row.id === 'telegram' && post.mediaUrls.some(looksLikeVideo) &&
        (post.mediaUrls.length !== 1 || !isVideoUrl(post.mediaUrls[0]))) throw failure('CONTENT_LIMIT');
    /* Пустой текст допустим только для Instagram Story с материалом; вторая защита после транспорта. */
    const withoutText = !post.text.trim();
    if (withoutText && (!storyMode || !post.mediaUrls.length)) throw failure('CONTENT_LIMIT');
    if (row.id === 'youtube_shorts') {
      const title = typeof post.title === 'string' ? post.title.trim() : '';
      if (!title) throw failure('CONTENT_LIMIT');
      const videos = post.mediaUrls.filter(isVideoUrl);
      if (post.mediaUrls.length !== 1 || videos.length !== 1) throw failure('CONTENT_LIMIT');
      // privacy: публикация из кабинета делается публичной осознанно, это видно в подписи действия.
      if (title.length > 100) throw failure('CONTENT_LIMIT');
      extra.title = title;
      extra.platform_options = {youtube:{is_shorts:true,privacy:'public'}};
    }
    /* С этой точки запрос ушёл провайдеру (specs/215-publish-verify, FR-1). «Не отправлено» и «неизвестно» различаются:
       - документированный разобранный отказ 400/401/403/404/429 и 422 с retryable:false — задание точно не создано.
         Ошибка получает rejection (понятная причина), доставка становится failed, её можно исправить и отправить снова;
       - таймаут, обрыв, 5xx, неразобранный ответ и 422 с retryable:true — задание могло быть создано. Ошибка помечается
         submitted: доставка на проверке, сверка ищет задание только чтением. Повторной отправки нет. */
    try {
      return receipt(await request(row,'POST','/posts',{profile_ids:[row.target],...(withoutText ? {} : {content:post.text}),
        publish_now:true,...(post.mediaUrls.length ? {media_urls:post.mediaUrls} : {}),...extra}),row);
    } catch (error) {
      if (error && typeof error === 'object') {
        const status = error.httpStatus;
        const notCreated = error.ambiguous === false && [400,401,403,404,422,429].includes(status) && !(status === 422 && error.retryable !== false);
        if (notCreated) error.rejection = status === 429 ? 'RATE_LIMITED' : [401,403].includes(status) ? 'AUTH_FAILED' : 'PROVIDER_REJECTED';
        else error.submitted = true;
      }
      throw error;
    }
  }
  async function reconcile(row,providerPostId) {
    if (!id(providerPostId) || !id(row.target)) throw failure('PROVIDER_POST_REQUIRED');
    return receipt(await request(row,'GET',`/posts/${encodeURIComponent(providerPostId)}`),row,providerPostId);
  }
  /* Поиск созданного задания без идентификатора (ответ на POST потерян или был неоднозначным).
     Только чтение GET /posts своего профиля. Совпадение строгое: тот же профиль, отпечаток SHA-256
     нормализованного текста, создано в окне попытки, и такое задание ровно одно. Иначе — null.
     Читаются все страницы списка (limit=100, page=1…meta.pages), но не больше SEARCH_PAGES: у профиля с большим
     числом заданий поиск неполон и завершается ошибкой RESPONSE_UNCERTAIN, а не «не найдено» — по неполному поиску
     доставку нельзя признать неотправленной. null означает, что весь список прочитан и совпадения нет. */
  async function findSubmitted(row,{contentSha,submittedAt}) {
    if (!id(row.target) || typeof contentSha !== 'string' || !/^[a-f0-9]{64}$/.test(contentSha)) throw failure('PROVIDER_POST_REQUIRED');
    const since = Date.parse(submittedAt);
    if (Number.isNaN(since)) throw failure('PROVIDER_POST_REQUIRED');
    const seen = new Map();
    for (let page = 1; ; page++) {
      const body = await request(row,'GET',`/posts?profile_id=${encodeURIComponent(row.target)}&limit=${SEARCH_LIMIT}&page=${page}`,null,{whole:true});
      const list = body.data;
      if (!Array.isArray(list) || list.length > SEARCH_LIMIT) throw failure('RESPONSE_UNCERTAIN');
      // Между страницами могут появиться новые задания и сдвинуть список: одно задание учитывается один раз.
      for (const item of list) if (item && typeof item === 'object' && id(item.id) && !seen.has(item.id)) seen.set(item.id,item);
      const pages = body.meta && typeof body.meta === 'object' ? body.meta.pages : undefined;
      if (pages === undefined) {
        // Без сведений о страницах полный ответ может означать продолжение — тогда поиск неполон.
        if (list.length < SEARCH_LIMIT) break;
        throw failure('RESPONSE_UNCERTAIN');
      }
      if (!Number.isSafeInteger(pages) || pages < 0) throw failure('RESPONSE_UNCERTAIN');
      if (page >= pages) break;
      if (page >= SEARCH_PAGES) throw failure('RESPONSE_UNCERTAIN');
    }
    const matches = Array.from(seen.values()).filter(item => {
      if (!item || typeof item !== 'object' || Array.isArray(item) || !id(item.id) || typeof item.content !== 'string') return false;
      if (profileOf(item) !== row.target || !['draft','scheduled','published','failed'].includes(item.status)) return false;
      const created = Date.parse(item.created_at);
      if (Number.isNaN(created) || created < since - 10 * 60000 || created > since + 60 * 60000) return false;
      return contentDigest(item.content) === contentSha;
    });
    if (matches.length !== 1) return null;
    return receipt(matches[0],row,matches[0].id);
  }
  /* Ссылка на конкретный пост. Публикационный Post у Onlypult ссылки не содержит (openapi.yaml, проверено
     07.11.2026); permalink есть только в аналитике (AnalyticsTopItem.url) и только для Instagram и TikTok
     среди наших площадок. Мост — linked_publish_profile.id === наш профиль публикации. Совпадение строгое:
     время выхода ±30 минут и начало подписи; кандидат ровно один, ссылка https на домен площадки.
     Любая неясность, отсутствие аналитики в тарифе или ошибка → null: ссылка не выдумывается. */
  const PERMALINK = {instagram:{analytics:'instagram',host:/(^|\.)instagram\.com$/},tiktok:{analytics:'tiktok',host:/(^|\.)tiktok\.com$/}};
  async function permalink(row,{publishedAt,text}) {
    const spec = PERMALINK[row.id];
    const at = Date.parse(publishedAt);
    if (!spec || !id(row.target) || Number.isNaN(at) || typeof text !== 'string' || !normalize(text)) return null;
    let profiles,top;
    try {
      profiles = await request(row,'GET',`/analytics/profiles?platform=${spec.analytics}`);
      if (!Array.isArray(profiles)) return null;
      const linked = profiles.filter(profile => profile && typeof profile.id === 'string' && /^an_[A-Za-z0-9_-]{1,100}$/.test(profile.id) &&
        profile.platform === spec.analytics && String(profile.linked_publish_profile?.id ?? '') === row.target);
      if (linked.length !== 1) return null;
      const day = ms => new Date(ms).toISOString().slice(0,10);
      top = await request(row,'GET',`/analytics/${encodeURIComponent(linked[0].id)}/top-posts?date_from=${day(at - 86400000)}&date_to=${day(at + 86400000)}&limit=50`);
    } catch {return null;}
    const items = Array.isArray(top?.items) ? top.items : [];
    const own = normalize(text);
    const candidates = items.filter(item => {
      if (!item || typeof item !== 'object' || !Number.isSafeInteger(item.published_at) || Math.abs(item.published_at - at) > 30 * 60000) return false;
      let url;
      try {url = new URL(item.url);} catch {return false;}
      if (url.protocol !== 'https:' || url.username || url.password || url.port || !spec.host.test(url.hostname.toLowerCase())) return false;
      const caption = normalize(typeof item.caption === 'string' ? item.caption : typeof item.title === 'string' ? item.title : '').replace(/(\.\.\.|…)$/,'').trim();
      if (!caption) return false;
      // Подпись площадки обрезается до 500 символов: короткий текст — точное совпадение, длинный — общее начало не короче 40 символов.
      return caption === own || (caption.length >= 40 && own.startsWith(caption)) || (own.length >= 40 && caption.startsWith(own));
    });
    if (candidates.length !== 1) return null;
    return new URL(candidates[0].url).href;
  }
  return {listProfiles,inspectProfiles,check,publish,reconcile,findSubmitted,permalink};
}
// Нормализация текста для отпечатка: переводы строк, пробелы по краям и подряд. Сам текст не хранится.
const normalize = value => String(value || '').replace(/\r\n?/g,'\n').replace(/[ \t]+/g,' ').replace(/ *\n */g,'\n').trim();
const contentDigest = value => require('node:crypto').createHash('sha256').update(normalize(value)).digest('hex');
module.exports = {createOnlypultProvider,contentDigest,normalizeText:normalize};
