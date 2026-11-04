 'use strict';
const crypto = require('node:crypto');
const deny = (code) => { throw Object.assign(Error(code), { status:403, code }); };
function createViewAs({secret, authStore, db}) {
  const sign = value => crypto.createHmac('sha256', secret).update(value).digest('base64url');
  return {
    issue(session, userId) {
      if (session.user.role !== 'owner') deny('VIEW_AS_FORBIDDEN');
      const user = authStore.getById(Number(userId));
      if (!user) deny('VIEW_AS_INVALID');
      const payload = Buffer.from(JSON.stringify({uid:user.id, owner:session.user.id,
        binding:sign(session.csrf), exp:Date.now()+3600000, nonce:crypto.randomBytes(16).toString('hex')})).toString('base64url');
      db.prepare("INSERT INTO auth_audit(actor_user_id,target_user_id,action,details_json,created_at) VALUES(?,?,'VIEW_AS_STARTED','{}',?)")
        .run(session.user.id,user.id,new Date().toISOString());
      return {token:payload+'.'+sign(payload)};
    },
    resolve(request, session) {
      if (!session || session.user.role !== 'owner' || session.user.mustChangePassword || request.headers['x-api-key']) deny('VIEW_AS_FORBIDDEN');
      const [payload,sig,...extra] = String(request.headers['x-view-as']).split('.');
      const expected = sign(payload || '');
      if (extra.length || !/^[A-Za-z0-9_-]{43}$/.test(sig||'') || sig.length!==expected.length || !crypto.timingSafeEqual(Buffer.from(sig),Buffer.from(expected))) deny('VIEW_AS_INVALID');
      let data; try { data=JSON.parse(Buffer.from(payload,'base64url')); } catch { deny('VIEW_AS_INVALID'); }
      if (data.owner!==session.user.id || data.binding!==sign(session.csrf) || !(data.exp>Date.now())) deny('VIEW_AS_INVALID');
      const user=authStore.getById(data.uid);
      if (!user) deny('VIEW_AS_INVALID');
      if (request.method!=='GET') deny('VIEW_AS_READONLY');
      return {...session,user,viewAs:{active:true,readOnly:true,userId:user.id,name:user.displayName}};
    }
  };
}
module.exports={createViewAs};
