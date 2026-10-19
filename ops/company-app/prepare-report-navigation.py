"""Локальный кандидат перехода на отчёт из открытого R3. Сервер не используется."""
import argparse
import hashlib
import json
from pathlib import Path

PINS = {
    'company-context.js': 'ee8d9c0ab1e72febd3df1a34ed559505056c56f526984a6ab6f1e1f4fb95df45',
    'shell.js': 'ddf516a035144301a93d3d93d30768c2ef169e66a1d0f62b740714ceb8590faa',
    'cabinet.html': 'a63d26a5ffaff8eb3a4e0485dd20fe045dbca2f9c1d1237e21e2739c39aa3b63',
}
sha = lambda raw: hashlib.sha256(raw).hexdigest()


def prepare(base, output):
    if output.exists():
        raise ValueError('OUTPUT_ALREADY_EXISTS')
    original = {name: (base / name).read_bytes() for name in PINS}
    if any(sha(raw) != PINS[name] for name, raw in original.items()):
        raise ValueError('EXACT_INSTALLED_R3_PRODUCT_REQUIRED')
    files = {name: raw.decode('utf-8') for name, raw in original.items()}

    def change(name, before, after):
        if files[name].count(before) != 1:
            raise ValueError('EXACT_SINGLE_INTEGRATION_POINT_REQUIRED:' + name)
        files[name] = files[name].replace(before, after)

    files['company-context.js'] = Path(__file__).with_name('company-context.js').read_text(encoding='utf-8')
    if 'function createReportNavigation(' not in files['company-context.js']:
        raise ValueError('REVIEWABLE_NAVIGATION_HELPER_REQUIRED')
    change('shell.js', "  let salonReportView = null, salonReportKey = '', initialSalonReport = null, salonEntryError = '';",
           "  let reportNavigation = null;\n  let salonReportView = null, salonReportKey = '', initialSalonReport = null, salonEntryError = '';")
    change('shell.js', "history.replaceState(null, '', salonReportHash(query));", "history.replaceState(null, '', salonReportHash(query)); reportNavigation?.remember(location.hash);")
    change('shell.js', "history.replaceState(null, '', salonReportHash(salonReportView.query()));", "history.replaceState(null, '', salonReportHash(salonReportView.query())); reportNavigation?.remember(location.hash);")
    change('shell.js', "history.replaceState(null, '', `#${next.replace(/\\?$/, '')}`);", "history.replaceState(null, '', `#${next.replace(/\\?$/, '')}`); reportNavigation?.remember(location.hash);")
    change('shell.js', "  render();\n  if (bridge && preview) signIn(", """  if (multiCompany && Companies?.createReportNavigation && SalonReports?.entry) {
    reportNavigation = Companies.createReportNavigation({
      parse: SalonReports.entry, initialHash: location.hash, readBlockers: sessionUpdateSafety,
      replaceHash: hash => history.replaceState(null, '', hash || location.pathname),
      reload: () => location.reload(), onBlocked: message => toast(message)
    });
    const followReportLink = () => reportNavigation.observe(location.hash);
    window.addEventListener('hashchange', followReportLink);
    window.addEventListener('popstate', followReportLink);
    window.addEventListener('pagehide', event => {
      if (event.persisted) return;
      reportNavigation.dispose();
      window.removeEventListener('hashchange', followReportLink);
      window.removeEventListener('popstate', followReportLink);
    });
  }
  render();
  if (bridge && preview) signIn(""")
    change('shell.js', '/* PALITRA_UI_BUILD:synapse-company-app-20261019-r2 */', '/* PALITRA_UI_BUILD:synapse-company-app-20261019-r4 */')
    change('shell.js', "const SESSION_UI_BUILD = 'synapse-company-app-20261019-r2';", "const SESSION_UI_BUILD = 'synapse-company-app-20261019-r4';")
    files['cabinet.html'] = files['cabinet.html'].replace('v=20261019-r2', 'v=20261019-r4')
    output.mkdir(parents=True)
    manifest = []
    for name, body in files.items():
        raw = body.encode('utf-8')
        (output / name).write_bytes(raw)
        manifest.append({'name': name, 'beforeSha256': PINS[name], 'afterSha256': sha(raw), 'bytes': len(raw)})
    (output / 'MANIFEST.json').write_text(json.dumps({'contract': 'report-navigation-candidate/v1', 'build': 'synapse-company-app-20261019-r4', 'installed': False, 'files': manifest}, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    return manifest


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--base', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(prepare(args.base, args.output), ensure_ascii=False))
