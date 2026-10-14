#!/usr/bin/env python3
"""Selected readonly runtime facts. No env dump, installs, network or data writes."""
import argparse
import hashlib
import json
import re
import subprocess
import sys

CONTENT = "synapse-content-1"
WORKER = "synapse-chat-1"
CADDY = "synapse-caddy-1"
CONTENT_IMAGE = "sha256:8a98cf8656cc139e6cbb842f81bc05e20c534065b2274063629b18c32db3fa72"
WORKER_IMAGE = "sha256:c5dd4502daf630afaac7415da5b19dc456c81a5f81626574f5480dec04307cca"
HOSTS = {"palitra-love.ru", "palitra-love-draft-1.synapsebusiness.ru", "synapse.synapsebusiness.ru"}
IMAGE = re.compile(r"^sha256:[0-9a-f]{64}$")
LIMIT = 4 * 1024 * 1024
# Selected fields only; no inspect .Config.Env or project-module imports.
NODE_FACTS = r"""'use strict';
const fs=require('node:fs'),path=require('node:path');
const approvedOrigins=new Set(['https://palitra-love.ru','https://palitra-love-draft-1.synapsebusiness.ru','https://synapse.synapsebusiness.ru']);
const result={flags:{},origins:{}};
for(const name of ['PALITRA_CHECKOUT_ENABLED','PALITRA_CRM_ENABLED','PALITRA_CUSTOMER_CHAT_ENABLED','PALITRA_WEB_UPLOADS_ENABLED']){
 const v=process.env[name];result.flags[name]=v===undefined?null:v==='true'?true:v==='false'?false:'invalid';
}
for(const name of ['PALITRA_MAIN_ORIGIN','PALITRA_SHOP_ORIGIN','PALITRA_CRM_SYNAPSE_ORIGIN']){
 const v=process.env[name];result.origins[name]=v===undefined||v===''?null:approvedOrigins.has(v)?v:'invalid_or_unapproved';
}
if(process.argv[1]==='yes'){
 const v=process.env.PALITRA_CRM_BOT_ID;result.botId=v===undefined||v===''?null:/^[1-9][0-9]{0,19}$/.test(v)?v:'invalid';
}
function regularChain(p,kind){
 if(!path.isAbsolute(p)||path.normalize(p)!==p)throw Error();
 let current='';const parts=p.split('/').filter(Boolean);
 for(let i=0;i<parts.length;i++){current+='/'+parts[i];const s=fs.lstatSync(current);if(s.isSymbolicLink()||(i<parts.length-1&&!s.isDirectory()))throw Error();}
 const s=fs.lstatSync(p);if(kind==='dir'?!s.isDirectory():!s.isFile())throw Error();
 if(fs.realpathSync(p)!==p)throw Error();return s;
}
try{
 const database=process.env.DATABASE_PATH||'/data/content.sqlite';
 if(database!=='/data/content.sqlite')throw Error();
 const fixed='site-44bbe13f1bad5e005b2a';
 const versions=path.join(path.dirname(database),'projects','palitra-love','sites',fixed,'versions');
 regularChain(versions,'dir');result.workspaceVersionsRoot=versions;
 result.publishedRoot=null;result.publishedMetadataRead=false;
 if(process.argv[2]==='yes'){
  regularChain(database,'file');
  const {DatabaseSync}=require('node:sqlite'),db=new DatabaseSync(database,{readOnly:true});
  try{
   const row=db.prepare('SELECT m.id,m.company_code,w.hostname,w.current_revision FROM managed_sites m JOIN site_workspaces w ON w.site_id=m.id WHERE m.id=? AND m.company_code=? AND m.deleted_at IS NULL AND m.is_active=1').get(fixed,'palitra-love');
   if(!row||row.id!==fixed||row.company_code!=='palitra-love'||row.hostname!=='palitra-love-draft-1.synapsebusiness.ru'||!/^[0-9a-f]{64}$/.test(row.current_revision))throw Error();
   const root=path.join(versions,row.current_revision);regularChain(root,'dir');
   const index=regularChain(path.join(root,'index.html'),'file'),order=regularChain(path.join(root,'assets/order.js'),'file');
   if(index.size===0||order.size===0)throw Error();
   result.publishedMetadataRead=true;result.publishedRoot=root;
   result.published={siteId:row.id,company:row.company_code,hostname:row.hostname,revision:row.current_revision,indexBytes:index.size,orderBytes:order.size};
  }finally{db.close()}
 }else result.pending='active current_revision resides in existing DB; enable explicit --published-metadata for fixed public metadata query';
 process.stdout.write(JSON.stringify(result));
}catch(e){process.stderr.write('SAFE_RUNTIME_FACTS_REFUSED\n');process.exit(41)}
"""

# Only selected static mounts and the data mount needed to project a fixed public
# workspace subtree. The raw /data mount is never included in outer output.
MOUNT_FORMAT = '{{range .Mounts}}{{if or (eq .Destination "/srv/sites") (eq .Destination "/site-sources") (eq .Destination "/site-sources/palitra-love") (eq .Destination "/site-sources/palitra-draft") (eq .Destination "/data")}}{{json .Type}}\t{{json .Source}}\t{{json .Destination}}\t{{json .RW}}{{println}}{{end}}{{end}}'


class Refused(Exception):
    pass


def need(condition, message):
    if not condition:
        raise Refused(message)


def load_json(raw):
    try:
        def unique(items):
            obj = {}
            for key, value in items:
                need(key not in obj, "Duplicate JSON")
                obj[key] = value
            return obj
        return json.loads(raw, object_pairs_hook=unique)
    except (ValueError, UnicodeError):
        raise Refused("Invalid readonly JSON") from None


def run(arguments, runner):
    try:
        result = runner(arguments, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                        stderr=subprocess.PIPE, shell=False, check=False, timeout=30)
    except (OSError, subprocess.TimeoutExpired):
        raise Refused("Readonly runtime command unavailable") from None
    need(result.returncode == 0 and isinstance(result.stdout, bytes) and len(result.stdout) <= LIMIT,
         "Readonly runtime command refused or oversized")
    return result.stdout


def image(container, runner):
    need(container in {CONTENT, WORKER, CADDY}, "Unexpected container")
    value = run(['docker', 'inspect', '--format', '{{.Image}}', container], runner).decode('ascii').strip()
    need(IMAGE.fullmatch(value), "Expected full immutable image")
    return value


def path_text(value):
    return isinstance(value, str) and re.fullmatch(r'/[a-zA-Z0-9_./-]+', value) and '..' not in value


def mounts(container, versions_root, runner):
    raw = run(['docker', 'inspect', '--format', MOUNT_FORMAT, container], runner)
    rows = []
    for line in raw.splitlines():
        if not line:
            continue
        fields = line.split(b'\t')
        need(len(fields) == 4, "Invalid selected mounts")
        kind, source, destination, rw = [load_json(value) for value in fields]
        need(kind in {'bind', 'volume'} and path_text(source) and path_text(destination) and type(rw) is bool,
             "Invalid selected mount fields")
        if destination == '/data':
            # Fixed public versions projection; never expose raw private data mount.
            if container == CONTENT and versions_root.startswith('/data/projects/palitra-love/sites/site-44bbe13f1bad5e005b2a/versions'):
                suffix = versions_root[len('/data/'):]
                rows.append({'type': kind, 'source': source.rstrip('/') + '/' + suffix,
                             'destination': versions_root, 'readOnly': not rw, 'projection': 'fixed-public-workspace-versions'})
            continue
        need(destination in {'/srv/sites', '/site-sources', '/site-sources/palitra-love', '/site-sources/palitra-draft'},
             "Unexpected mount destination")
        rows.append({'type': kind, 'source': source, 'destination': destination, 'readOnly': not rw})
    return rows


def project_routes(config):
    rows = []
    allowed_upstreams = {'content:8080', 'crm:8080', 'chat:8080'}
    # No arbitrary webhook paths or URI tokens from adapted configuration.
    selected_paths = {'/', '/*', '/content/*', '/cabinet/*', '/cabinet.html', '/love-app/*',
                      '/palitra-app/*', '/api/orders', '/api/orders/*', '/api/customer-chat/*',
                      '/api/draft-account/*', '/api/crm/*', '/api/price', '/api/assets/*',
                      '/chat', '/account/*', '/account/login', '/account/register', '/catalog'}

    def visit(route, hosts=None, paths=None):
        if not isinstance(route, dict):
            return
        hosts, paths = set(hosts or ()), list(paths or ())
        uncertain = False
        for match in route.get('match', []):
            if not isinstance(match, dict):
                continue
            if 'host' in match:
                hosts = {h for h in match['host'] if h in HOSTS}
            if 'path' in match:
                paths = [p for p in match['path'] if p in selected_paths]
                uncertain |= len(paths) != len(match['path'])
            uncertain |= any(key not in {'host', 'path', 'method'} for key in match)
        for handler in route.get('handle', []):
            if not isinstance(handler, dict):
                continue
            for nested in handler.get('routes', []):
                visit(nested, hosts, paths)
            if not hosts:
                continue
            row = {'hosts': sorted(hosts), 'paths': paths or ['/*']}
            if uncertain:
                row['additionalMatchConditions'] = True
            kind = handler.get('handler')
            if kind == 'vars' and path_text(handler.get('root')):
                root = handler['root']
                if root.startswith(('/srv/sites/', '/site-sources/', '/data/projects/palitra-love/')):
                    row['root'] = root
            elif kind == 'reverse_proxy':
                upstreams = [u.get('dial') for u in handler.get('upstreams', []) if isinstance(u, dict)]
                row['reverse_proxy'] = [u for u in upstreams if u in allowed_upstreams]
                row['unprojectedUpstreamCount'] = sum(u not in allowed_upstreams for u in upstreams)
            elif kind == 'headers':
                response = handler.get('response', {})
                headers = response.get('set', {}) if isinstance(response, dict) else {}
                for name, values in headers.items():
                    if name.lower() == 'x-frame-options':
                        row['xFrameOptions'] = [v for v in values if v in {'DENY', 'SAMEORIGIN'}]
                    elif name.lower() == 'content-security-policy':
                        frames = []
                        for value in values:
                            if not isinstance(value, str):
                                continue
                            match = re.search(r'(?:^|;)\s*frame-ancestors\s+([^;]+)', value)
                            if match:
                                frames += [v for v in match.group(1).split() if v in {"'self'", "'none'"} or v in {'https://' + h for h in HOSTS}]
                        row['frameAncestorSources'] = frames
            if len(row) > 2:
                rows.append(row)
                need(len(rows) <= 120, "Too many selected routes")
    servers = config.get('apps', {}).get('http', {}).get('servers', {})
    need(isinstance(servers, dict), "Invalid Caddy route tree")
    for server in servers.values():
        for route in server.get('routes', []):
            visit(route)
    return rows


def collect(*, include_bot_id=False, published_metadata=False, runner=subprocess.run):
    before = {container: image(container, runner) for container in (CONTENT, WORKER, CADDY)}
    need(before[CONTENT] == CONTENT_IMAGE and before[WORKER] == WORKER_IMAGE, "Unexpected content/worker image")
    raw = run(['docker', 'exec', CONTENT, 'node', '-e', NODE_FACTS, '--',
               'yes' if include_bot_id else 'no', 'yes' if published_metadata else 'no'], runner)
    facts = load_json(raw)
    expected_fields = {'flags','origins','workspaceVersionsRoot','publishedRoot','publishedMetadataRead',
                       'published' if published_metadata else 'pending'}
    if include_bot_id:
        expected_fields.add('botId')
    need(isinstance(facts, dict) and set(facts) == expected_fields, "Unexpected facts fields")
    need(set(facts.get('flags', {})) == {'PALITRA_CHECKOUT_ENABLED','PALITRA_CRM_ENABLED','PALITRA_CUSTOMER_CHAT_ENABLED','PALITRA_WEB_UPLOADS_ENABLED'} and
         all(v is None or type(v) is bool or v == 'invalid' for v in facts['flags'].values()), "Invalid selected flags")
    need(set(facts.get('origins', {})) == {'PALITRA_MAIN_ORIGIN','PALITRA_SHOP_ORIGIN','PALITRA_CRM_SYNAPSE_ORIGIN'} and
         all(v is None or v == 'invalid_or_unapproved' or v in {'https://' + h for h in HOSTS} for v in facts['origins'].values()), "Invalid selected origins")
    need(facts.get('workspaceVersionsRoot') == '/data/projects/palitra-love/sites/site-44bbe13f1bad5e005b2a/versions', "Invalid workspace root")
    if include_bot_id:
        need(facts.get('botId') is None or facts['botId'] == 'invalid' or re.fullmatch(r'[1-9][0-9]{0,19}', str(facts['botId'])), "Invalid numeric bot id")
    else:
        need('botId' not in facts, "Bot id was not requested")
    need(facts.get('publishedMetadataRead') is published_metadata, "Published metadata mode mismatch")
    if published_metadata:
        entry = facts.get('published', {})
        need(set(entry) == {'siteId','company','hostname','revision','indexBytes','orderBytes'} and
             entry['siteId'] == 'site-44bbe13f1bad5e005b2a' and entry['company'] == 'palitra-love' and
             entry['hostname'] == 'palitra-love-draft-1.synapsebusiness.ru' and re.fullmatch(r'[0-9a-f]{64}', entry['revision']) and
             facts.get('publishedRoot') == facts['workspaceVersionsRoot'] + '/' + entry['revision'], "Invalid fixed published metadata")
    else:
        need(facts.get('publishedRoot') is None and 'published' not in facts and facts.get('pending') ==
             'active current_revision resides in existing DB; enable explicit --published-metadata for fixed public metadata query', "Unexpected published data")
    adapted = run(['docker', 'exec', CADDY, 'caddy', 'adapt', '--config', '/etc/caddy/Caddyfile', '--adapter', 'caddyfile'], runner)
    routes = project_routes(load_json(adapted))
    projected_mounts = {container: mounts(container, facts['workspaceVersionsRoot'], runner) for container in (CONTENT, CADDY)}
    after = {container: image(container, runner) for container in (CONTENT, WORKER, CADDY)}
    need(before == after, "Images changed during readonly facts")
    return {'status': 'READONLY_FACTS', 'images': after, 'selected': facts, 'routes': routes,
            'routeProjectionOnly': True, 'caddyAdaptSha256': hashlib.sha256(adapted).hexdigest(),
            'publicMounts': projected_mounts, 'network': 0, 'runtimeWrites': 0}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--include-bot-id', action='store_true')
    parser.add_argument('--published-metadata', action='store_true', help='Explicit readonly fixed-site public workspace metadata query')
    args = parser.parse_args(argv)
    try:
        result = collect(include_bot_id=args.include_bot_id, published_metadata=args.published_metadata)
    except (Refused, UnicodeError, TypeError, KeyError, AttributeError):
        print(json.dumps({'status': 'REFUSED', 'reason': 'Selected readonly runtime proof failed; no dump emitted'}))
        return 2
    print(json.dumps(result, ensure_ascii=False, separators=(',', ':')))
    return 0


if __name__ == '__main__':
    sys.exit(main())
