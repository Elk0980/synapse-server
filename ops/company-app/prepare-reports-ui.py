"""Apply the reports layer after the verified company-switch shell preparation.

Only local candidate files are changed. Does not install or contact any service.
"""
from pathlib import Path
import shutil

root = Path(__file__).resolve().parent
out = root / 'product'
source = {name: (out / name).read_text(encoding='utf-8') for name in ['shell.js', 'native-host.js', 'cabinet.html']}

def change(name, old, new):
    if source[name].count(old) != 1:
        raise ValueError((name, old[:90], source[name].count(old)))
    source[name] = source[name].replace(old, new)

change('native-host.js', '      workflow: Object.freeze({ request: async (path, options = {}) => {', '''      customerReports: Object.freeze({ request: async (query = {}, options = {}) => {
        if (entry !== 'cabinet' || origin !== CABINET || FLAGS.network !== true || !['alvi', 'avokado'].includes(activeCompany)) throw Object.assign(new Error('Отчёты этой компании ещё не подключены.'), { status: 403 });
        for (const key of Object.keys(query)) if (!['mode', 'month', 'day', 'basis'].includes(key) || typeof query[key] !== 'string') throw new TypeError('Неизвестный фильтр отчёта');
        const path = `/content/${window.SynapseCompanies.profile(activeCompany).site}/customer-reports?${new URLSearchParams(query)}`;
        const response = await window.fetch(path, { method: 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: options.signal, headers: { Accept: 'application/json' } });
        if (!response.ok) throw Object.assign(new Error(response.status === 403 ? 'Нет доступа к отчётам этой компании.' : response.status === 401 ? 'Войдите в приложение заново.' : 'Не удалось получить отчёт.'), { status: response.status });
        return response.json();
      } }),
      workflow: Object.freeze({ request: async (path, options = {}) => {''')
change('shell.js', '  const companyForms = new Map();', '''  const companyForms = new Map();
  const SalonReports = window.SynapseCustomerReports;
  const salonQueries = new Map();
  let salonReportView = null, salonReportKey = '', initialSalonReport = null, salonEntryError = '';
  try { initialSalonReport = SalonReports?.entry(location.hash); } catch (error) { salonEntryError = error.message; }
  const salonAllowed = () => Boolean(auth.cabinet?.member && (auth.cabinet.role === 'owner' || auth.cabinet.permissions?.includes('analytics.view')));
  function disposeSalonReports() { salonReportView?.dispose(); salonReportView = null; salonReportKey = ''; }
  function salonReportHash(query) { return '#reports?' + new URLSearchParams({ company: activeCompany, mode: query.mode, month: query.month, ...(query.day ? { day: query.day } : {}) }); }
  function salonReportScreen() {
    const key = `${actorKey()}|${tickets.epoch}`;
    if (!SalonReports || !HOST?.customerReports) return [h('p', { class: 'app-empty', text: 'Отчёты ещё не подключены.' })];
    if (salonReportView && salonReportKey !== key) disposeSalonReports();
    if (!salonReportView) {
      salonReportKey = key;
      salonReportView = SalonReports.create({ document, window, companyCode: activeCompany, query: salonQueries.get(activeCompany),
        request: (query, options) => HOST.customerReports.request(query, options),
        onQuery: query => { salonQueries.set(activeCompany, query); try { history.replaceState(null, '', salonReportHash(query)); } catch (_) {} },
        onUnauthorized: error => endSession('cabinet', error.message) });
    }
    try { history.replaceState(null, '', salonReportHash(salonReportView.query())); } catch (_) {}
    return [salonReportView.element];
  }''')
change('shell.js', '    const frame = frameById(id);\n    if (!frame)', '''    const frame = frameById(id);
    if (salonReportView) { salonQueries.set(activeCompany, salonReportView.query()); disposeSalonReports(); }
    if (!frame)''')
change('shell.js', '    if (!profile) {\n      clearIdentityData', '''    disposeSalonReports();
    if (!profile) {
      clearIdentityData''')
change('shell.js', '    companyForms.clear();', '    disposeSalonReports(); salonQueries.clear();\n    companyForms.clear();')
change('shell.js', '          const selected = companyContext.initialize(who, readPreferredCompany(who));', '''          if (salonEntryError) throw Object.assign(new Error(salonEntryError), { status: 403 });
          const preferred = initialSalonReport ? initialSalonReport.company : readPreferredCompany(who);
          if (initialSalonReport && !who.companies?.some(c => (typeof c === 'string' ? c : c.id) === preferred)) throw Object.assign(new Error('Нет доступа к компании из ссылки отчёта'), { status: 403 });
          const selected = companyContext.initialize(who, preferred);''')
change('shell.js', "    const requestedWorkflow = initialWorkflowRoute; initialWorkflowRoute = false;", '''    const reportEntry = initialSalonReport; initialSalonReport = null;
    if (reportEntry) salonQueries.set(reportEntry.company, reportEntry.query);
    const requestedWorkflow = initialWorkflowRoute; initialWorkflowRoute = false;''')
change('shell.js', "    if (!requestedWorkflow && requestedOrder && detail", '''    if (reportEntry && state.role && salonAllowed()) {
      const reportFrame = framesFor(state.role).find(f => screenType(f) === 'reports' && f.hidden !== true);
      if (reportFrame) open(reportFrame.id, {}, { replace: true }); else { state.authError = 'Экран отчётов недоступен для этого входа'; render(); }
    } else if (!requestedWorkflow && requestedOrder && detail''')
# Use the existing frame helper. Staff reports are added without changing Palitra's model.
source['shell.js'] = source['shell.js'].replace("framesFor(state.role).find(f => screenType(f) === 'reports'", "frames().filter(f => f.role === state.role).find(f => screenType(f) === 'reports'")
extend_report_frames = """    if (activeCompany === 'palitra-love' || !salonAllowed()) return list;
    for (const role of ['staff', 'admin']) if (!list.some(f => f.role === role && f.kind === 'reports' && f.hidden !== true))
      list.push({ id: role === 'staff' ? 'S_REPORTS' : 'A_REPORTS', role, kind: 'reports', device: 'mobile', title: 'Отчёты', menuVisible: true, blocks: [] });
    return list.map(frame => {
      if (frame.id !== MENU_HOME[frame.role]) return frame;
      const report = list.find(f => f.role === frame.role && f.kind === 'reports' && f.hidden !== true);
      if (!report || frame.blocks.some(b => b.type === 'button' && b.target === report.id)) return frame;
      return { ...frame, blocks: [...frame.blocks, { id: `${frame.id}-studio-reports`, type: 'button', label: 'Отчёты', target: report.id }] };
    });
"""
legacy_frames = "  const frames = () => { const existing = DESIGN ? DESIGN.frames : []; return existing.some((f) => f.id === 'A10') ? existing : [...existing, { id: 'A10', role: 'admin', kind: 'workflow', device: 'phone', title: 'Автоответ и этапы', blocks: [] }]; };"
if source['shell.js'].count(legacy_frames) == 1:
    change('shell.js', legacy_frames, """  const frames = () => {
    const existing = DESIGN ? DESIGN.frames : [];
    const list = existing.some(f => f.id === 'A10') ? [...existing] : [...existing, { id: 'A10', role: 'admin', kind: 'workflow', device: 'phone', title: 'Автоответ и этапы', blocks: [] }];
""" + extend_report_frames + '  };')
else:
    # Reviewed widget33/34 builds add the shared client chat and staff lists here.
    # Extend their exact existing list; keep every old/new native frame intact.
    change('shell.js', "    return [...existing, ...builtins.filter(f => !existing.some(old => old.id === f.id))];\n  };",
           "    const list = [...existing, ...builtins.filter(f => !existing.some(old => old.id === f.id))];\n" + extend_report_frames + '  };')
change('shell.js', "    return effectiveMenu(role).menu.items.filter((item) => {", "    const visible = effectiveMenu(role).menu.items.filter((item) => {")
change('shell.js', "      return true;\n    });\n  }\n  function homeFrame(role)", """      return true;
    });
    if (activeCompany !== 'palitra-love' && salonAllowed()) {
      const report = mobileFrame(role, 'reports');
      if (report && !visible.some(item => item.target === report.id)) visible.push({ id: `studio-reports:${role}`, label: 'Отчёты', target: report.id });
    }
    return visible;
  }
  function homeFrame(role)""")
change('shell.js', "      if (type === 'reports') {\n        if (c['cabinet.summary'])", "      if (type === 'reports' && activeCompany === 'palitra-love') {\n        if (c['cabinet.summary'])")
change('shell.js', "    if (type === 'reports') return c['cabinet.summary'] === true || c['portal.summary'] === true;", "    if (type === 'reports') return activeCompany !== 'palitra-love' ? salonAllowed() : c['cabinet.summary'] === true || c['portal.summary'] === true;")
change('shell.js', "  function reportsScreen(frame) {\n    if (caps()['cabinet.summary'])", "  function reportsScreen(frame) {\n    if (activeCompany !== 'palitra-love') return salonAllowed() ? salonReportScreen() : [h('p', { class: 'app-empty', text: 'Нет доступа к отчётам этой компании.' })];\n    if (caps()['cabinet.summary'])")
change('shell.js', "    const frame = frameById(state.frameId);\n    const phone = $('phone');", "    const frame = frameById(state.frameId);\n    if (salonReportView && (screenType(frame) !== 'reports' || activeCompany === 'palitra-love' || !salonAllowed())) disposeSalonReports();\n    const phone = $('phone');")
change('shell.js', "    disposeFreeLayouts(); if (attachmentUI) attachmentUI.unmount();", "    disposeSalonReports(); disposeFreeLayouts(); if (attachmentUI) attachmentUI.unmount();")
change('shell.js', "onReturn: () => { scheduleChatGeometry(); scheduleChatRefresh(); }", "onReturn: () => { scheduleChatGeometry(); scheduleChatRefresh(); salonReportView?.refresh(); }")
change('shell.js', "if (event.persisted) { scheduleChatGeometry(); scheduleChatRefresh(); }", "if (event.persisted) { scheduleChatGeometry(); scheduleChatRefresh(); salonReportView?.refresh(); }")
change('cabinet.html', '<link rel="stylesheet" href="workflow-ui.css?v=1">', '<link rel="stylesheet" href="customer-reports-ui.css?v=20261018-r1">\n<link rel="stylesheet" href="workflow-ui.css?v=1">')
change('cabinet.html', '<script src="company-context.js?v=20261018-r1"></script>', '<script src="company-context.js?v=20261018-r1"></script>\n<script src="customer-reports-ui.js?v=20261018-r1"></script>')
for name, text in source.items():
    if name == 'cabinet.html':
        text=text.replace('v=20261018-r1','v=20261019-r2')
    (out / name).write_text(text, encoding='utf-8', newline='\n')
for name in ['customer-reports-ui.js', 'customer-reports-ui.css', 'report-source.html', 'report-source-ui.js', 'report-source.css']:
    shutil.copy2(root / name, out / name)
print('Reports candidate prepared locally; not installed.')
