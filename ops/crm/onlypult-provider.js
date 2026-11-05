'use strict';

// Contract: https://onlypult.com/dev/openapi.yaml, inspected 2026-09-17.
// Post has id/status/profile_ids; its schema DOES NOT document a published URL.
// 02.11.2026 (Влад): статус Onlypult «published» показывается в приложении как «Опубликовано —
// подтвердил Onlypult» без выдуманной ссылки; ссылка появляется, только если найдена на самой площадке.
const BASE = 'https://api.onlypult.com/v1';
// Onlypult's live response on 2026-09-17 uses "vk"; OpenAPI documents "vkontakte".
/* Соответствие площадок Synapse значениям Profile.platform у Onlypult.
   Значения для instagram/tiktok/max взяты из проверенной OpenAPI (29.09.2026), не из догадок:
   у Instagram два варианта входа, оба означают бизнес-профиль. */
const PLATFORM = {vk:['vkontakte','vk'],telegram:['telegram'],youtube_shorts:['youtube'],
  instagram:['instagram_business_login','instagram_business'],tiktok:['tiktok'],max:['max']};
/* Ключ platform_options и закрытый список полей, которые Onlypult принимает для этой площадки.
   Опции одной площадки никогда не уходят другой: отправляется только ключ своей площадки. */
const OPTION_KEY = {instagram:'instagram',tiktok:'tiktok',max:'max',telegram:'telegram',vk:'vkontakte',youtube_shorts:'youtube'};
/* 02.11.2026: полный набор параметров Onlypult для наших площадок (SDK 0.1.9, openapi.yaml).
   Ключи без точки уходят в platform_options площадки; остальные раскладываются по запросу:
   first_comment и delete_at_* — поля поста, show_caption_above_media и primary_attachments_mode —
   post_options, poll_* — объект poll площадки. Других ключей нет. */
const DELETE_FIELDS = ['delete_after_value','delete_after_unit'];
const POLL_FIELDS = ['poll_question','poll_options','poll_multiple','poll_anonymous'];
const OPTION_FIELDS = {
  instagram:['is_story','is_reels','disable_comment','graduation_strategy','first_comment',...DELETE_FIELDS],
  tiktok:['privacy','disable_comment','disable_duet','disable_stitch',...DELETE_FIELDS],
  max:['pin_message',...DELETE_FIELDS],
  telegram:['pin_message','show_caption_above_media',...POLL_FIELDS,...DELETE_FIELDS],
  vk:['disable_comment','attachments_mode',...POLL_FIELDS,...DELETE_FIELDS],
  youtube_shorts:['privacy',...DELETE_FIELDS],
};
const DELETE_UNIT_SECONDS = {minutes:60,hours:3600,days:86400,weeks:604800};
/* Раскладка сохранённых параметров площадки в поля запроса Onlypult. Неверное значение —
   CONTENT_LIMIT до POST: опубликовать не то, что согласовали, нельзя. */
function requestOptions(platform, options, failure) {
  const settings = {}, extra = {};
  for (const [key, value] of Object.entries(options)) {
    if (!OPTION_FIELDS[platform].includes(key)) throw failure('CONTENT_LIMIT');
    if (DELETE_FIELDS.includes(key) || POLL_FIELDS.includes(key)) continue;
    if (key === 'first_comment') {
      if (typeof value !== 'string' || !value.trim() || value.length > 2200) throw failure('CONTENT_LIMIT');
      extra.first_comment = value;
    } else if (key === 'show_caption_above_media') {
      if (typeof value !== 'boolean') throw failure('CONTENT_LIMIT');
      extra.post_options = {...(extra.post_options || {}), show_caption_above_media: value};
    } else if (key === 'attachments_mode') {
      if (!['carousel','grid'].includes(value)) throw failure('CONTENT_LIMIT');
      extra.post_options = {...(extra.post_options || {}), primary_attachments_mode: value};
    } else settings[key] = value;
  }
  const hasDelete = DELETE_FIELDS.map(key => Object.hasOwn(options, key));
  if (hasDelete[0] !== hasDelete[1]) throw failure('CONTENT_LIMIT');
  if (hasDelete[0]) {
    const amount = options.delete_after_value, unit = DELETE_UNIT_SECONDS[options.delete_after_unit];
    if (!Number.isSafeInteger(amount) || amount < 1 || amount > 999 || !unit) throw failure('CONTENT_LIMIT');
    Object.assign(extra, {delete_at_enable: true, delete_at_offset_value: amount, delete_at_offset_unit: unit});
  }
  if (POLL_FIELDS.some(key => Object.hasOwn(options, key))) {
    const question = options.poll_question, answers = options.poll_options;
    if (typeof question !== 'string' || !question.trim() || question.length > 300 || !Array.isArray(answers) ||
        answers.length < 2 || answers.length > 10 || answers.some(item => typeof item !== 'string' || !item.trim() || item.length > 100) ||
        ['poll_multiple','poll_anonymous'].some(key => Object.hasOwn(options, key) && typeof options[key] !== 'boolean')) throw failure('CONTENT_LIMIT');
    settings.poll = {question, options: answers,
      ...(Object.hasOwn(options, 'poll_multiple') ? {multiple: options.poll_multiple} : {}),
      ...(Object.hasOwn(options, 'poll_anonymous') ? {anonymous: options.poll_anonymous} : {})};
  }
  return {settings, extra};
}
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
const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value);
/* Instagram Story без подписи. Контракт https://onlypult.com/dev/openapi.yaml (OpenAPI 3.0.3, info.version 1.0.0,
   проверен root 30.09.2026): PostCreateRequest.required = [profile_ids]; content — string без minLength,
   «Required unless media_ids or media_urls is provided». PlatformSettings.is_story — Story для Instagram,
   несовместим с is_reels/is_shorts. Поэтому при материале и пустом тексте content не отправляется вовсе. */
/* «2026-11-02 21:37:28» в часовом поясе аккаунта → ISO UTC. Пусто или нераспознано → null. */
function utcOf(value,zone) {
  const m = typeof value === 'string' && /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value.trim());
  if (!m) return null;
  const wall = Date.UTC(+m[1],m[2]-1,+m[3],+m[4],+m[5],+(m[6]||0));
  const shift = at => {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone:zone,hourCycle:'h23',year:'numeric',month:'2-digit',
      day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit'}).formatToParts(new Date(at)).map(p => [p.type,p.value]));
    return Date.UTC(+parts.year,parts.month-1,+parts.day,+parts.hour,+parts.minute,+parts.second) - at;
  };
  let at = wall - shift(wall);
  at = wall - shift(at);
  return Number.isFinite(at) ? new Date(at).toISOString() : null;
}
function createOnlypultProvider({failure,readResponse,fetchImpl,tokenFor}) {
  async function request(row,method,path,body) {
    const token = tokenFor(row), mutation = method !== 'GET';
    let response,data;
    try {
      // Создание поста ждёт дольше: Onlypult сначала сам скачивает видео (02.11.2026: 20 с не хватило для TikTok).
      const signal = AbortSignal.timeout(mutation ? 90000 : 20000);
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
      if (rejected) throw failure([401,403].includes(response.status) ? 'ACCESS_DENIED' : 'PLATFORM_REJECTED');
      throw failure('CONNECTION_UNCERTAIN',mutation);
    }
    if (!data || typeof data !== 'object' || !Object.hasOwn(data,'data')) throw failure('RESPONSE_UNCERTAIN',mutation);
    return data.data;
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
    // Причина неработающего доступа нужна только проверке перед отправкой и наружу не отдаётся.
    const messages = new Map(profiles.filter(profile => id(profile?.id) && typeof profile.status_message === 'string')
      .map(profile => [profile.id,profile.status_message.slice(0,80)]));
    return {profiles:matching,messages,diagnostics:{totalProfiles:profiles.length,
      platformCounts:Array.from(counts,([platform,count]) => ({platform,count})).sort((a,b) => a.platform.localeCompare(b.platform)),
      profileShapes:Array.from(shapes.values()),otherShapesCount}};
  }
  async function listProfiles(row) {return (await inspectProfiles(row)).profiles;}
  async function check(row) {
    if (!id(row.target)) throw failure('PROFILE_REQUIRED');
    const {profiles,messages} = await inspectProfiles(row), matches = profiles.filter(profile => profile.id === row.target);
    if (matches.length !== 1) throw failure('PROFILE_NOT_FOUND');
    if (matches[0].status !== 'active') throw failure('PROFILE_INACTIVE');
    /* status_message (например invalid_access_token) в API Onlypult отстаёт: 02.11.2026 после переподключения
       кабинет показывал «Токен активен», а API ещё старую причину. Поэтому она не блокирует отправку —
       итог даёт сам Onlypult (failed), и он показывается в приложении. */
    void messages;
    return matches[0];
  }
  /* Посты профиля — только чтение. Время Onlypult приходит без зоны, в часовом поясе аккаунта;
     здесь оно переводится в UTC. Пост другого профиля или неизвестной формы в список не попадает. */
  async function listPosts(row,{limit = 30} = {}) {
    if (!id(row.target)) throw failure('PROFILE_REQUIRED');
    const account = await request(row,'GET','/account');
    const zone = typeof account?.timezone === 'string' ? account.timezone : '';
    try {new Intl.DateTimeFormat('en-US',{timeZone:zone});} catch {throw failure('RESPONSE_UNCERTAIN');}
    const posts = await request(row,'GET',`/posts?profile_id=${encodeURIComponent(row.target)}&limit=${limit}`);
    if (!Array.isArray(posts)) throw failure('RESPONSE_UNCERTAIN');
    return posts.filter(post => post && typeof post === 'object' && id(post.id) && profileOf(post) === row.target &&
      ['draft','scheduled','published','failed'].includes(post.status)).map(post => ({
      id:post.id,status:post.status,content:typeof post.content === 'string' ? post.content : '',
      title:typeof post.title === 'string' ? post.title : '',
      createdAt:utcOf(post.created_at,zone),publishedAt:utcOf(post.published_at,zone),
      error:typeof post.error === 'string' ? post.error.slice(0,300) : null}));
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
    // 02.11.2026: создание поста отвечает списком из одного поста (по поступившему profile_ids), чтение — объектом.
    if (Array.isArray(data) && data.length === 1) data = data[0];
    const profile = data && typeof data === 'object' && !Array.isArray(data) ? profileOf(data) : null;
    // Площадка названа — сверяем точно. Ответ без неё допустим только при строгом совпадении профиля.
    const platformNamed = data && Object.hasOwn(data,'platform');
    if (platformNamed && !PLATFORM[row.id]?.includes(data.platform)) throw failure('RESPONSE_UNCERTAIN',true);
    if (!data || !id(data.id) || (expectedId && data.id !== expectedId) ||
        !profile || profile !== row.target ||
        !['draft','scheduled','published','failed'].includes(data.status)) throw failure('RESPONSE_UNCERTAIN',true);
    return {provider:'onlypult',providerPostId:data.id,providerStatus:data.status,status:'needs_review',
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
    // 02.11.2026: файл больше лимита тарифа Onlypult отклоняется до отправки. Размер не узнали — не блокируем.
    if (positive(limits?.global_max_file_size)) for (const media of post.mediaUrls) {
      let size = NaN;
      try {
        const head = await fetchImpl(media,{method:'HEAD',redirect:'error',signal:AbortSignal.timeout(10000)});
        size = Number(head?.headers?.get?.('content-length'));
      } catch {}
      if (Number.isFinite(size) && size > limits.global_max_file_size) throw failure('FILE_TOO_LARGE');
    }
    guard();
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
      const {settings: options, extra: requestExtra} = requestOptions(row.id, chosen || {}, failure);
      Object.assign(extra, requestExtra);
      if (row.id === 'instagram') {
        /* Story и Reel — разные режимы, и пределы одного на другой не переносятся.
           Reel — это ровно одно вложение, и оно видео: фото «в довесок» к ролику не уходит. */
        if (options.is_story === true && options.is_reels === true) throw failure('CONTENT_LIMIT');
        if (options.is_reels === true && (post.mediaUrls.length !== 1 || !isVideoUrl(post.mediaUrls[0]))) throw failure('CONTENT_LIMIT');
        if (!post.mediaUrls.length) throw failure('CONTENT_LIMIT');
      }
      /* Здесь потребитель Onlypult REST, а не приложение нативного TikTok API.
         В Onlypult передаётся ровно согласованный режим из его закрытого контракта.
         Это не список возможностей конкретного автора: неподдерживаемый выбор должен
         отклонить провайдер. Умолчания, замены аудитории и повторный POST запрещены. */
      if (row.id === 'tiktok') {
        if (!['PUBLIC_TO_EVERYONE', 'MUTUAL_FOLLOW_FRIENDS', 'FOLLOWER_OF_CREATOR', 'SELF_ONLY'].includes(options.privacy)) throw failure('TIKTOK_PRIVACY_REQUIRED');
        if (['disable_comment','disable_duet','disable_stitch'].some(key => Object.hasOwn(options,key) && typeof options[key] !== 'boolean')) throw failure('CONTENT_LIMIT');
        if (post.mediaUrls.filter(isVideoUrl).length !== 1 || post.mediaUrls.length !== 1) throw failure('CONTENT_LIMIT');
      }
      if (row.id === 'instagram' && Object.hasOwn(options, 'graduation_strategy') && options.is_reels !== true) throw failure('CONTENT_LIMIT');
      if (row.id === 'youtube_shorts') {
        /* Shorts всегда is_shorts; доступ — согласованный в материале, без выбора — открытый, как раньше. */
        if (Object.hasOwn(options, 'privacy') && !['public','unlisted','private'].includes(options.privacy)) throw failure('CONTENT_LIMIT');
        options.is_shorts = true;
        if (!Object.hasOwn(options, 'privacy')) options.privacy = 'public';
      }
      if (Object.keys(options).length) extra.platform_options = {[OPTION_KEY[row.id]]: options};
    } else if (chosen && Object.keys(chosen).length) {
      // Опции для площадки, у которой публикуемых опций нет, не отправляются вовсе.
      throw failure('CONTENT_LIMIT');
    }
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
    }
    return receipt(await request(row,'POST','/posts',{profile_ids:[row.target],...(withoutText ? {} : {content:post.text}),
      publish_now:true,...(post.mediaUrls.length ? {media_urls:post.mediaUrls} : {}),...extra}),row);
  }
  async function reconcile(row,providerPostId) {
    if (!id(providerPostId) || !id(row.target)) throw failure('PROVIDER_POST_REQUIRED');
    return receipt(await request(row,'GET',`/posts/${encodeURIComponent(providerPostId)}`),row,providerPostId);
  }
  /* Ссылка на вышедший пост — только с самой площадки и только при однозначном совпадении.
     YouTube: публичная RSS канала (platform_id профиля) — заголовок совпадает, выход в пределах 45 минут.
     Остальные площадки публичного источника с сервера не дают (02.11.2026: t.me и Instagram недоступны
     из Москвы, стена ВКонтакте закрыта для анонимных) — возвращается null, ссылка не придумывается. */
  async function findLink(row,{title,text,publishedAt}) {
    if (row.id !== 'youtube_shorts') return null;
    const profile = await request(row,'GET',`/profiles/${encodeURIComponent(row.target)}`);
    const channel = typeof profile?.platform_id === 'string' ? profile.platform_id : '';
    if (!/^UC[\w-]{22}$/.test(channel)) return null;
    let xml;
    try {
      const signal = AbortSignal.timeout(15000);
      const response = await fetchImpl('https://www.youtube.com/feeds/videos.xml?channel_id=' + channel,{redirect:'error',signal});
      if (!response.ok) return null;
      xml = await readResponse(response,signal);
    } catch {return null;}
    const clean = value => String(value || '').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"')
      .replace(/&#39;/g,"'").normalize('NFC').replace(/\s+/g,' ').trim().toLowerCase();
    const wanted = clean(title || text), at = Date.parse(publishedAt);
    if (!wanted || !Number.isFinite(at)) return null;
    const hits = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(m => ({
      video:(m[1].match(/<yt:videoId>([\w-]{11})<\/yt:videoId>/) || [])[1],
      title:clean((m[1].match(/<title>([\s\S]*?)<\/title>/) || [])[1]),
      published:Date.parse((m[1].match(/<published>([^<]+)<\/published>/) || [])[1])}))
      .filter(entry => entry.video && entry.title === wanted && Math.abs(entry.published - at) <= 45 * 60000);
    return hits.length === 1 ? `https://www.youtube.com/shorts/${hits[0].video}` : null;
  }
  return {listProfiles,inspectProfiles,check,publish,reconcile,listPosts,findLink};
}
module.exports = {createOnlypultProvider};
