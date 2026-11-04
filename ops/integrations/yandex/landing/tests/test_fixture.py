import importlib.util
import json
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('local_fixture', ROOT / 'fixture_server.py')
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)

class FixtureTests(unittest.TestCase):
    def test_write_requests_are_rejected_without_any_forwarding(self):
        for method in ['POST', 'PUT', 'PATCH', 'DELETE']:
            status, _, raw = fixture.route_response(method, '/api/leads')
            self.assertEqual(status, 405)
            self.assertEqual(raw, b'LOCAL_FIXTURE_WRITE_DISABLED')

    def test_html_injects_fixture_guard_before_runtime_scripts(self):
        status, _, raw = fixture.route_response('GET', '/' + fixture.PAGES[0])
        self.assertEqual(status, 200)
        self.assertLess(raw.index(b'/__fixture__/guard.js'), raw.index(b'/callback.js'))
        self.assertIn('form-action \'none\'', fixture.CSP)
        self.assertIn('connect-src \'self\'', fixture.CSP)
        self.assertIn('window.__metrikaReady = true', fixture.GUARD)

    def test_fixture_supports_ready_and_two_failure_cases(self):
        status, _, raw = fixture.route_response('GET', '/api/price', 'ready')
        self.assertEqual(status, 200)
        data = json.loads(raw)
        self.assertTrue(any(c['id'] == 'first-visit' for c in data['categories']))
        self.assertEqual(fixture.route_response('GET', '/api/price', 'unavailable')[0], 503)
        changed = json.loads(fixture.route_response('GET', '/api/price', 'unexpected')[2])
        cat = next(c for c in changed['categories'] if c['id'] == 'first-visit')
        self.assertEqual(next(i for i in cat['items'] if i['id'] == 'first-1')['price'], '650 ₽')

    def test_only_allowlisted_routes_are_readable(self):
        for path in ['/../../BASE_MANIFEST.json', '/%2e%2e/BASE_MANIFEST.json', '/BASE_MANIFEST.json', '/tools/build_from_public.py']:
            self.assertEqual(fixture.route_response('GET', path)[0], 404)
        self.assertEqual(fixture.route_response('GET', '/callback.js?v=20261001-goals')[0], 200)

if __name__ == '__main__':
    unittest.main()
