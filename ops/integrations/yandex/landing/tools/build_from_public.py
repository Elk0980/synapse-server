"""Deterministic candidate build from the explicitly handed-off public snapshot.
Writes only inside this landing/ folder. No network, production, or submission.
"""
from pathlib import Path
import argparse
import hashlib
import json
import re
import shutil

ROOT = Path(__file__).resolve().parents[1]
BASE = None
PINS = {
    'index.html': 'a7ff72162e9568d0fd6330a4b32bd1c6bbe20f071e11785c6d2f4eb3e4721b07',
    'price.html': 'f924aa191fefd377b0663fe7aa4423f192bca2143b7e32378e1dfa23d1312ea9',
    'callback.js': '60de6f0e66b9d2a5ceb0095c434b1834c4dcac01dfba3921b639de6e72c430aa',
}
def sha(raw):
    return hashlib.sha256(raw).hexdigest()

def main():
    global BASE
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base', type=Path, required=True, help='Reviewed public snapshot directory')
    BASE = parser.parse_args().base.resolve()
    for name, expected in PINS.items():
        assert sha((BASE / name).read_bytes()) == expected, f'BASE_MISMATCH:{name}'
    source = (BASE / 'index.html').read_bytes().decode('utf-8')
    match = re.search(r'<section class="av-callback" id="callback"[\s\S]*?</section>', source)
    assert match, 'CALLBACK_SECTION_MISSING'
    callback = match.group(0)
    assert callback.count('<form ') == 1 and 'action="/api/leads"' in callback
    data = json.loads((BASE / 'price-live.json').read_bytes())
    cats = [c for c in data['categories'] if c['id'] == 'first-visit']
    assert len(cats) == 1
    items = [item for item in cats[0]['items'] if item['id'] == 'first-1']
    assert len(items) == 1
    item = items[0]
    contract = {key: item[key] for key in ['id', 'title', 'card', 'duration', 'price', 'desc', 'composition']}
    digest = sha(json.dumps(contract, ensure_ascii=False, separators=(',', ':')).encode('utf-8'))
    script = ROOT / 'avokado-yandex-landing.js'
    js = script.read_bytes().decode('utf-8')
    found = re.search(r"const OFFER_CONTRACT_SHA = '([^']+)';", js)
    assert found and found.group(1) in ('__OFFER_CONTRACT_SHA__', digest), 'REVIEWED_OFFER_CHANGED'
    script.write_bytes(js.replace("'__OFFER_CONTRACT_SHA__'", repr(digest)).encode('utf-8'))
    template = (ROOT / 'tools/landing.template.html').read_bytes().decode('utf-8')
    pages = {
        'turbo-massazh-irkutsk.html': 'ТУРБО-массаж в Иркутске',
        'apparatnyy-massazh-irkutsk.html': 'Аппаратный массаж в Иркутске',
    }
    for name, h1 in pages.items():
        page = template.replace('__TITLE__', h1 + ' — первый ТУРБО-визит | Авокадо')
        page = page.replace('__FILENAME__', name).replace('__H1__', h1).replace('__CALLBACK_SECTION__', callback)
        (ROOT / name).write_bytes(page.encode('utf-8'))
    fixture = ROOT / 'fixtures/public'
    fixture.mkdir(parents=True, exist_ok=True)
    for name in ['callback.js', 'attribution.js', 'price-live.json']:
        shutil.copyfile(BASE / name, fixture / name)
    (ROOT / 'fixtures/callback-section.html').write_bytes(callback.encode('utf-8'))
    manifest = {
        'schema': 'avokado-yandex-landing-base/v1', 'source': 'reviewed-public-https-snapshot',
        'sourceType': 'fresh-public-bytes-handed-off-by-root-2026-10-28',
        'sourceIsRepositoryCheckout': False,
        'api': '/api/price', 'categoryId': 'first-visit', 'itemId': 'first-1',
        'offerContractSha256': digest, 'callbackSectionSha256': sha(callback.encode('utf-8')),
        'files': [{'name': p.name, 'bytes': p.stat().st_size, 'sha256': sha(p.read_bytes())}
                  for p in sorted(BASE.iterdir()) if p.is_file()],
        'productionFiles': [*pages, 'avokado-yandex-landing.js', 'avokado-yandex-landing.css'],
        'unchangedRuntimeDependencies': ['/callback.js?v=20261001-goals', '/attribution.js?v=20261001-goals'],
        'deployed': False, 'campaignUrlsChanged': False,
    }
    (ROOT / 'BASE_MANIFEST.json').write_bytes((json.dumps(manifest, ensure_ascii=False, indent=2) + '\n').encode('utf-8'))
    print(json.dumps({'pages': list(pages), 'offerContractSha256': digest, 'productionWrites': 0}))

if __name__ == '__main__':
    main()
