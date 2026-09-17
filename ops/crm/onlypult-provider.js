'use strict';

// Contract: https://onlypult.com/dev/openapi.yaml, inspected 2026-09-17.
// Post has id/status/profile_ids; its schema DOES NOT document a published URL.
// A provider status alone must therefore never become Synapse "published".
const BASE = 'https://api.onlypult.com/v1';
const PLATFORM = {vk:'vkontakte',telegram:'telegram'};
const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value);
function createOnlypultProvider({failure,readResponse,fetchImpl,tokenFor}) {
  async function request(row,method,path,body) {
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
    const matching = profiles.filter(profile => profile?.platform === PLATFORM[row.id]).map(profile => {
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
  function receipt(data,row,expectedId) {
    if (!data || !id(data.id) || (expectedId && data.id !== expectedId) ||
        !Array.isArray(data.profile_ids) || data.profile_ids.length !== 1 || data.profile_ids[0] !== row.target ||
        !['draft','scheduled','published','failed'].includes(data.status)) throw failure('RESPONSE_UNCERTAIN',true);
    return {provider:'onlypult',providerPostId:data.id,providerStatus:data.status,status:'needs_review',
      errorCode:data.status === 'published' ? 'PROVIDER_LINK_UNAVAILABLE' : data.status === 'failed' ? 'PROVIDER_FAILED' : 'PROVIDER_PENDING'};
  }
  async function publish(row,post,guard) {
    await check(row);guard();
    const account = await request(row,'GET','/account');guard();
    if (account?.plan_active !== true) throw failure('PROVIDER_PLAN_INACTIVE');
    const limits = await request(row,'GET',`/posts/limits?profile_id=${encodeURIComponent(row.target)}`);guard();
    const textLimit = limits?.platform?.limits?.text?.charLimit, mediaLimit = limits?.platform?.limits?.media?.maxCount;
    if ((Number.isInteger(textLimit) && textLimit > 0 && post.text.length > textLimit) ||
        (Number.isInteger(mediaLimit) && mediaLimit > 0 && post.mediaUrls.length > mediaLimit)) throw failure('CONTENT_LIMIT');
    return receipt(await request(row,'POST','/posts',{profile_ids:[row.target],content:post.text,
      publish_now:true,...(post.mediaUrls.length ? {media_urls:post.mediaUrls} : {})}),row);
  }
  async function reconcile(row,providerPostId) {
    if (!id(providerPostId) || !id(row.target)) throw failure('PROVIDER_POST_REQUIRED');
    return receipt(await request(row,'GET',`/posts/${encodeURIComponent(providerPostId)}`),row,providerPostId);
  }
  return {listProfiles,inspectProfiles,check,publish,reconcile};
}
module.exports = {createOnlypultProvider};
