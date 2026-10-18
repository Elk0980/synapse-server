from pathlib import Path
import shutil, hashlib, json
import argparse
parser=argparse.ArgumentParser(description='Prepare the existing shared company shell locally')
parser.add_argument('--base',required=True,type=Path)
BASE=parser.parse_args().base
ROOT=Path(__file__).resolve().parent
OUT=ROOT/'product'
OUT.mkdir(exist_ok=True)
manifest=json.loads((BASE/'MANIFEST.json').read_text(encoding='utf-8-sig'))
pins={item['name']:item['sha256'] for item in manifest}
for name in ['shell.js','shell.css','synapse-bridge.js','native-host.js','cabinet.html']:
    if pins.get(name)!=hashlib.sha256((BASE/name).read_bytes()).hexdigest():
        raise ValueError(f'Public base checksum mismatch: {name}')
source={n:(BASE/n).read_text(encoding='utf-8') for n in ['shell.js','shell.css','synapse-bridge.js','native-host.js','cabinet.html']}
def change(name,old,new):
    if source[name].count(old)!=1:
        raise ValueError((name,old[:100],source[name].count(old)))
    source[name]=source[name].replace(old,new)

# One factory; each company closes over its own descriptor allowlist and fixed site.
change('synapse-bridge.js',"}(typeof globalThis !== 'undefined' ? globalThis : this, () => {\n  const COMPANY_CODE = 'palitra-love';      // компания кабинета/CRM\n  const CONTENT_SITE = 'palitra';           // сайт контента — другой идентификатор, не путать с компанией", """}(typeof globalThis !== 'undefined' ? globalThis : this, function build(companyCode = 'palitra-love') {
  const Companies = typeof module === 'object' && module.exports ? require('./company-context.js') : globalThis.SynapseCompanies;
  const company = Companies ? Companies.profile(companyCode) : companyCode === 'palitra-love' ? { code: 'palitra-love', site: 'palitra', name: 'Палитра', origin: 'https://palitra-love.ru' } : null;
  if (!company) throw new TypeError('Компания не поддерживается приложением');
  const COMPANY_CODE = company.code;
  const CONTENT_SITE = company.site;""")
change('synapse-bridge.js',"member: data.role === 'owner' || companies.includes(COMPANY_CODE)","member: companies.includes(COMPANY_CODE)")
change('synapse-bridge.js',"shop: 'https://palitra-love.ru'",'shop: company.origin')
change('synapse-bridge.js',"path: '/price-editor-palitra.html?site=https%3A%2F%2Fpalitra-love.ru'", "path: COMPANY_CODE === 'palitra-love' ? '/price-editor-palitra.html?site=https%3A%2F%2Fpalitra-love.ru' : `/price-editor.html?site=${CONTENT_SITE}`")
# No unscoped photo editor fallback to another company's last selection.
change('synapse-bridge.js',"path: '/cabinet/site-photos.html'", "path: `/cabinet/site-photos.html?company=${COMPANY_CODE}&site=${CONTENT_SITE}`")
change('synapse-bridge.js',"path: '/catalog'", "path: COMPANY_CODE === 'palitra-love' ? '/catalog' : '/price.html'")
change('synapse-bridge.js',"    COMPANY_CODE, CONTENT_SITE, NAMESPACES", "    forCompany: code => build(code), COMPANY: company,\n    COMPANY_CODE, CONTENT_SITE, NAMESPACES")
change('synapse-bridge.js',"      const operation = OPERATIONS[name];\n      if (operation.entity)", """      const operation = OPERATIONS[name];
      if (COMPANY_CODE !== 'palitra-love' && (operation.auth !== 'cabinet' || name.startsWith('thread.') || name === 'legacy.reply')) fail('Эта функция ещё не подключена для выбранной компании', 'NOT_CONNECTED');
      if (operation.entity)""")
# Native transport repeats the company restriction even for direct transport callers.
change('synapse-bridge.js',"      const request = verified(raw);   //", "      const request = verified(raw);\n      if (COMPANY_CODE !== 'palitra-love' && (request.auth !== 'cabinet' || request.operation.startsWith('thread.') || request.operation === 'legacy.reply')) fail('Эта функция ещё не подключена для выбранной компании', 'NOT_CONNECTED');   //")
change('synapse-bridge.js',"'native.threads': cabMember && has('crm.view') ?", "'native.threads': COMPANY_CODE === 'palitra-love' && cabMember && has('crm.view') ?")
change('synapse-bridge.js',"'editor.photos': cabMember ? 'delegated' : false", "'editor.photos': COMPANY_CODE === 'palitra-love' && cabMember ? 'delegated' : false")

# Native host retains the existing sessions. No change to its live flags or tokens.
change('native-host.js',"  const listeners = [];", "  const listeners = [];\n  let activeCompany = 'palitra-love';")
change('native-host.js',"      mode: 'native', verified: true, origin, transport, e1Native: FLAGS.e1Native,", """      mode: 'native', verified: true, origin, transport, e1Native: FLAGS.e1Native,
      selectCompany: (code) => {
        if (entry !== 'cabinet' || !window.SynapseCompanies?.profile(code)) throw new Error('Компания недоступна для этого входа');
        activeCompany = code;
        return B.forCompany(code).createNativeTransport({ fetch: (url, init) => window.fetch(url, init),
          host: { origin, portalOrigin: SHOP, allowNetwork: FLAGS.network, e1Native: code === 'palitra-love' && FLAGS.e1Native,
            cabinet: { get csrfToken() { return cabinetCsrf; } } } });
      },""")
change('native-host.js',"if (entry !== 'cabinet' || origin !== CABINET || FLAGS.network", "if (activeCompany !== 'palitra-love' || entry !== 'cabinet' || origin !== CABINET || FLAGS.network")
change('native-host.js',"if (!permitted || !FLAGS.network", "if ((entry === 'cabinet' && activeCompany !== 'palitra-love') || !permitted || !FLAGS.network")

change('shell.js',"  const B = window.SynapseBridge, HOST = window.PalitraShellHost;", """  const ROOT_BRIDGE = window.SynapseBridge, HOST = window.PalitraShellHost;
  let B = ROOT_BRIDGE;
  const Companies = window.SynapseCompanies;
  const multiCompany = Boolean(Companies && HOST?.selectCompany && document.documentElement.dataset.entry === 'cabinet');
  let activeCompany = 'palitra-love', companyContext = null;
  const companyForms = new Map();""")
change('shell.js',"const actorKey = () => (auth.cabinet", "const actorKey = () => `${activeCompany}|` + (auth.cabinet")
change('shell.js',"  const attachmentUI = !preview", "  let attachmentUI = !preview")
change('shell.js',"  function workflowIdentity() { if (workflow) workflow.setIdentity({ key: actorKey(), role: auth.cabinet ? auth.cabinet.role : 'client', member: Boolean(auth.cabinet && auth.cabinet.member), permissions: auth.cabinet ? auth.cabinet.permissions : [] }); }", "  function workflowIdentity() { if (workflow) workflow.setIdentity({ key: actorKey(), role: activeCompany === 'palitra-love' && auth.cabinet ? auth.cabinet.role : 'client', member: activeCompany === 'palitra-love' && Boolean(auth.cabinet && auth.cabinet.member), permissions: activeCompany === 'palitra-love' && auth.cabinet ? auth.cabinet.permissions : [] }); }")
change('shell.js',"  function clearIdentityData() {", "  function clearIdentityData({ preserveCompanyContext = false } = {}) {\n    companyForms.clear();\n    if (companyContext && !preserveCompanyContext) companyContext.revoke();")
change('shell.js',"    const epoch = tickets.epoch + 1;\n    let shopProbe", "    let epoch = tickets.epoch + 1;\n    let shopProbe")
change('shell.js',"        auth.cabinet = B.parseIdentity(who);", """        if (multiCompany) {
          const selected = companyContext.initialize(who, readPreferredCompany(who));
          if (!selected) throw Object.assign(new Error('Нет доступных компаний для приложения'), { status: 403 });
          activateCompany(selected, who, { initial: true }); epoch = tickets.epoch;
        } else auth.cabinet = B.parseIdentity(who);""")
change('shell.js',"    renderDesktopNav();\n    if (!fresh)", "    renderDesktopNav();\n    renderCompanyNav();\n    if (!fresh)")
change('shell.js',"text: DESIGN ? str(DESIGN.appTitle) || 'Palitra Love заказы' : 'Palitra Love заказы'", "text: multiCompany && auth.cabinet ? Companies.profile(activeCompany)?.name || 'Компании' : DESIGN ? str(DESIGN.appTitle) || 'Palitra Love заказы' : 'Palitra Love заказы'")
workflow_guard = "    if (type === 'workflow') return Boolean(workflow"
if any(source['shell.js'].count(f'/* PALITRA_UI_BUILD:{build} */') == 1 and source['shell.js'].count(f"const SESSION_UI_BUILD = '{build}';") == 1 for build in ['palitra-chat-widget-compact-20261019-r1', 'palitra-chat-open-layout-20261019-r1']):
    # Releases35/36 include Palitra's widget settings beside its workflow screen. Keep
    # both native screens, but do not expose either under another studio.
    workflow_guard = "    if (type === 'workflow' || type === 'widget-settings') return Boolean(workflow"
change('shell.js', workflow_guard, workflow_guard.replace('return Boolean(workflow', "return activeCompany === 'palitra-love' && Boolean(workflow"))
change('shell.js',"if (!c['portal.staff']) sections.push(h('p', { class: 'hint', text: 'CRM Palitra: нет подтверждённой сессии сотрудника portal.' }));", "if (B.COMPANY_CODE === 'palitra-love' && !c['portal.staff']) sections.push(h('p', { class: 'hint', text: 'CRM Palitra: нет подтверждённой сессии сотрудника portal.' }));")
change('shell.js',"readOnly: !caps()['native.write'], subtitle: ref.ns === 'legacy' ? 'Переписка в боте'", "readOnly: !caps()['native.write'] || Boolean(B.COMPANY_CODE && B.COMPANY_CODE !== 'palitra-love'), subtitle: ref.ns === 'legacy' ? (B.COMPANY_CODE && B.COMPANY_CODE !== 'palitra-love' ? 'Переписка в боте · только просмотр' : 'Переписка в боте')")
# Insert helpers before initial sign-in code is invoked at the end of the renderer.
insert="""
  function preferredKey(who) { return `synapse-app-company-v1:${String(who.userId)}`; }
  function readPreferredCompany(who) { try { return sessionStorage.getItem(preferredKey(who)); } catch (_) { return null; } }
  function renderCompanyNav() {
    if (!multiCompany || !companyContext) return;
    const snapshot = companyContext.snapshot();
    Companies.renderNav({ document, parent: $('phone'), state: !state.role || state.role === 'client' ? { ...snapshot, companies: [] } : snapshot,
      select: code => { void companyContext.choose(code).catch(error => { toast(error.message); renderCompanyNav(); }); } });
  }
  function activateCompany(profile, who, options = {}) {
    if (!profile) {
      clearIdentityData({ preserveCompanyContext: true }); auth.cabinet = null; state.role = ''; state.frameId = null; render(); return;
    }
    const sameActor = auth.cabinet && String(who.userId) === auth.cabinet.userId;
    if (!options.initial || activeCompany !== profile.code || (auth.cabinet && !sameActor)) {
      clearTimeout(toastTimer); toastTimer = 0; ui.toast.hidden = true; ui.toast.textContent = '';
      if (!sameActor) clearIdentityData({ preserveCompanyContext: true });
      else {
        companyForms.set(`${auth.cabinet.userId}#${activeCompany}`, { ...form });
        disposeFreeLayouts(); tickets.bumpEpoch(); stopChatRefresh(); destroyFrames();
        attachmentUI?.setIdentity({ key: '', epoch: tickets.epoch }); attachmentUI?.unmount();
        attachmentComposer = null; earlierRead = null; earlierThreadsRead = null; nav.length = 0; counts.orders = 0;
        Object.assign(state, { bootstrap: null, native: null, detail: null, links: null, chat: null, chatBlocked: null, summary: null, crmReport: null,
          reportRange: null, reportDraft: null, reportLoading: false, clientThread: null, clientThreads: null, clientThreadsBefore: null,
          clientThreadLinked: false, error: '', menuOpen: false, works: false, installOpen: false, params: {} });
        sessionFileSafety.clear(); sessionOpaqueDirty = false; sessionConfirmedForm = null;
      }
    }
    activeCompany = profile.code; B = ROOT_BRIDGE.forCompany(profile.code);
    bridge = B.createBridge({ transport: HOST.selectCompany(profile.code), getAuth: () => auth });
    auth.cabinet = B.parseIdentity(who); auth.e1Native = profile.code === 'palitra-love' && HOST.e1Native === true;
    if (typeof HOST.acceptCabinetCsrf === 'function') HOST.acceptCabinetCsrf(auth.cabinet.csrfToken);
    attachmentUI = profile.code === 'palitra-love' && HOST.attachments && window.PalitraAttachmentsUI
      ? window.PalitraAttachmentsUI.create({ document, window, client: B.createAttachmentClient({ transport: HOST.attachments, getAuth: () => auth }),
        onUnauthorized: error => endSession('cabinet', error.message) }) : null;
    Object.assign(form, companyForms.get(`${auth.cabinet.userId}#${profile.code}`) || initialForm());
    try { sessionStorage.setItem(preferredKey(who), profile.code); } catch (_) { /* selection carries no access */ }
    document.title = `${profile.name} — приложение`;
    workflowIdentity();
    if (!options.initial) { state.role = uiRole(); state.frameId = null; open(homeFrame(state.role), {}, { replace: true }); refreshCounts(tickets.epoch); }
  }
  if (multiCompany) companyContext = Companies.create({
    verifyIdentity: () => bridge.call('staff.identity'),
    beforeSwitch: () => sessionUpdateSafety().filter(reason => !['draft', 'typing'].includes(reason)),
    activate: activateCompany, changed: renderCompanyNav,
  });

"""
change('shell.js',"  /* ---------- вход и смена identity ---------- */",insert+"  /* ---------- вход и смена identity ---------- */")
accepted_builds = ['palitra-attach-paperclip-20261018-r1', 'palitra-chat-avatar-hugh-20261019-r1', 'palitra-chat-composer-bottom-20261019-r1', 'palitra-chat-widget-20261019-r1', 'palitra-chat-widget-compact-20261019-r1', 'palitra-chat-open-layout-20261019-r1']
matched_builds = [build for build in accepted_builds
                  if source['shell.js'].count(f'/* PALITRA_UI_BUILD:{build} */') == 1
                  and source['shell.js'].count(f"const SESSION_UI_BUILD = '{build}';") == 1]
if len(matched_builds) != 1:
    raise ValueError('Unknown or inconsistent source build; review the fresh base first')
source_build = matched_builds[0]
if source_build in ['palitra-chat-widget-20261019-r1', 'palitra-chat-widget-compact-20261019-r1', 'palitra-chat-open-layout-20261019-r1']:
    # The shared-widget release adds a second staff list and two outstanding page
    # readers. None of those may survive a company change or revive a late result.
    change('shell.js', '        attachmentComposer = null; earlierRead = null; earlierThreadsRead = null; nav.length = 0; counts.orders = 0;',
           '        attachmentComposer = null; earlierRead = null; earlierThreadsRead = null; staffAdviceRead = null;\n        moreSiteChats = null; siteChatHeadRead = null; nav.length = 0; counts.orders = 0;')
    change('shell.js', 'clientThreadLinked: false, error: \'\', menuOpen:',
           'clientThreadLinked: false, siteChatThreads: null, siteChatThreadsBefore: null, error: \'\', menuOpen:')
    old_list = "    'legacy.list': op({ auth: 'cabinet', cabinetPermission: 'crm.view', method: 'GET', path: () => `/content/${CONTENT_SITE}/client-dialogs`, proof: 'installed-read', source: 'E/palitra-work.js:55' }),"
    change('synapse-bridge.js', old_list, old_list + """
    'legacy.list.page': op({ auth: 'cabinet', cabinetPermission: 'crm.view', method: 'GET', path: () => `/content/${CONTENT_SITE}/client-dialogs`, query: input => {
      const page = threadListQuery(input), result = {};
      if (own(page, 'before')) result.beforeId = page.before;
      if (own(page, 'limit')) result.limit = page.limit;
      return result;
    }, proof: 'reviewed-local', source: 'company-scoped-legacy-chat-list' }),""")
    change('shell.js', "  function staffThreadPage(data, before = null) {", """  function companyChatListOperation() { return activeCompany === 'palitra-love' ? 'thread.list.page' : 'legacy.list.page'; }
  function staffCompanyChatPage(data, before = null) {
    if (activeCompany === 'palitra-love') return staffThreadPage(data, before);
    if (!data || !Array.isArray(data.dialogs) || data.dialogs.length > 100) throw new Error('Не удалось загрузить список переписок.');
    return staffThreadPage({ threads: data.dialogs, nextBefore: data.nextCursor }, before);
  }
  function staffThreadPage(data, before = null) {""")
    change('shell.js', "staffThreadPage(await bridge.call('thread.list.page', { query: { limit: 30 } }))",
           "staffCompanyChatPage(await bridge.call(companyChatListOperation(), { query: { limit: 30 } }))")
    change('shell.js', "staffThreadPage(await bridge.call('thread.list.page', { query: { before, limit: 30 } }), before)",
           "staffCompanyChatPage(await bridge.call(companyChatListOperation(), { query: { before, limit: 30 } }), before)")
    change('shell.js', "    const chat = mobileFrame(state.role, 'chat'), rows = state.siteChatThreads;",
           "    const chat = mobileFrame(state.role, 'chat'), rows = state.siteChatThreads, namespace = activeCompany === 'palitra-love' ? 'thread' : 'legacy';")
    change('shell.js', "text: 'Переписки с сайта'", "text: activeCompany === 'palitra-love' ? 'Переписки с сайта' : 'Переписки'")
    change('shell.js', "dataset: { thread: `thread:${row.id}` }", "dataset: { thread: `${namespace}:${row.id}` }")
    change('shell.js', "{chat:`thread:${row.id}`, ...(row.orderId === null ? {} : {order:`native-order:${row.orderId}`})}",
           "{chat:`${namespace}:${row.id}`, ...(row.orderId === null ? {} : {order:`native-order:${row.orderId}`})}")
    change('shell.js', "row.orderId === null ? `Чат сайта №${row.id}` : `Общий чат · заявка №${row.orderId}`",
           "activeCompany === 'palitra-love' ? (row.orderId === null ? `Чат сайта №${row.id}` : `Общий чат · заявка №${row.orderId}`) : (row.orderId === null ? `Переписка №${row.id}` : `Переписка · заявка №${row.orderId}`)")
change('shell.js', "  const CHANNEL_AUTHOR = {", """  function chatAuthorLabel(author) {
    return author === 'shop' && activeCompany !== 'palitra-love' ? Companies.profile(activeCompany)?.name || 'Компания' : CHANNEL_AUTHOR[author] || str(author);
  }
  const CHANNEL_AUTHOR = {""")
change('shell.js', '${CHANNEL_AUTHOR[author] || str(author)}', '${chatAuthorLabel(author)}')
if source_build != 'palitra-attach-paperclip-20261018-r1':
    change('shell.js', "    if (['shop', 'operator', 'manager', 'owner'].includes(author)) {", "    if (activeCompany === 'palitra-love' && ['shop', 'operator', 'manager', 'owner'].includes(author)) {")
    change('shell.js', "    const label = CHANNEL_AUTHOR[author] || str(author) || 'Участник';", "    const label = chatAuthorLabel(author) || 'Участник';")
change('shell.js', f'/* PALITRA_UI_BUILD:{source_build} */', '/* PALITRA_UI_BUILD:synapse-company-app-20261018-r1 */')
change('shell.js', f"const SESSION_UI_BUILD = '{source_build}';", "const SESSION_UI_BUILD = 'synapse-company-app-20261018-r1';")
source['shell.css']+='''\n/* One persistent company menu in the existing shell, including mobile safe area. */
.company-nav { flex:0 0 auto; display:flex; gap:6px; padding:8px 10px max(8px,env(safe-area-inset-bottom)); border-top:1px solid var(--line); background:var(--paper); z-index:5; }
.company-nav__item { flex:1 1 0; min-width:0; min-height:48px; padding:8px 6px; border:1px solid transparent; border-radius:12px; background:transparent; color:var(--muted); cursor:pointer; font-weight:600; font-size:.88rem; }
.company-nav__item[aria-pressed="true"] { color:var(--ink); background:var(--accent-soft); border-color:var(--accent); }
.company-nav__item:focus-visible { outline:3px solid var(--accent); outline-offset:1px; }
.company-nav__item:disabled { opacity:.6; cursor:wait; }
@media(min-width:1024px) { .phone:has(> .company-nav:not([hidden])) { grid-template-rows:76px minmax(0,1fr) auto; } .phone > .company-nav { grid-column:1 / -1; grid-row:3; } }
@media(max-width:1023px) and (max-height:430px) {
  .phone:has(> .company-nav:not([hidden])) .app-body--chat > .chat { gap:4px; }
  .phone:has(> .company-nav:not([hidden])) .chat__list { padding-top:0; padding-bottom:0; }
  .phone:has(> .company-nav:not([hidden])) .chat__dock { max-height:100%; grid-template-rows:minmax(24px,1fr) auto; }
  .phone:has(> .company-nav:not([hidden])) .chat__dock:has(> .chat__files[hidden]) { grid-template-rows:auto; }
  .phone:has(> .company-nav:not([hidden])) .chat__dock .chat__files { max-height:44px; }
  .phone:has(> .company-nav:not([hidden])) .chat__dock .chat__input { min-height:44px; max-height:44px; }
}
'''
change('cabinet.html','<title>Palitra Love заказы</title>','<title>Компании — приложение</title>')
change('cabinet.html','<script src="synapse-bridge.js?v=15"></script>', '<script src="company-context.js?v=20261018-r1"></script>\n<script src="synapse-bridge.js?v=20261018-r1"></script>')
source['cabinet.html']=source['cabinet.html'].replace('native-host.js?v=15','native-host.js?v=20261018-r1').replace('shell.js?v=15','shell.js?v=20261018-r1').replace('shell.css?v=4','shell.css?v=20261018-r1')
for name,text in source.items(): (OUT/name).write_text(text,encoding='utf-8',newline='\n')
shutil.copy2(ROOT/'company-context.js', OUT/'company-context.js')
print(json.dumps({'prepared':list(source)+['company-context.js'],'source_manifest':'BASE/MANIFEST.json','installed':False}))
