"""Download only this pinned code package; no installation or runtime changes."""
import argparse
import concurrent.futures
import hashlib
import json
import pathlib
import re
import urllib.request

PREFIX = 'https://raw.githubusercontent.com/Elk0980/synapse-server/'
PACKAGE = 'ops/palitra-editor-release/'


def get(url, limit):
    with urllib.request.urlopen(url, timeout=45) as response:
        body = response.read(limit + 1)
    if len(body) > limit:
        raise ValueError('Файл превышает объявленный размер')
    return body


def sha(body):
    return hashlib.sha256(body).hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--commit', required=True)
    parser.add_argument('--target', required=True)
    parser.add_argument('--manifest-sha', required=True)
    args = parser.parse_args()
    if not re.fullmatch('[a-f0-9]{40}', args.commit) or not re.fullmatch('[a-f0-9]{64}', args.manifest_sha):
        raise ValueError('Нужны точный commit и SHA манифеста')
    target = pathlib.Path(args.target)
    if not target.is_absolute() or target.is_symlink() or not target.is_dir() or target == pathlib.Path('/'):
        raise ValueError('Нужен существующий отдельный абсолютный каталог без ссылки')
    for parent in target.parents:
        if parent.is_symlink():
            raise ValueError('Ссылка в пути запрещена')
    base = PREFIX + args.commit + '/' + PACKAGE
    manifest_body = get(base + 'BUILD_MANIFEST.json', 256 * 1024)
    if sha(manifest_body) != args.manifest_sha:
        raise ValueError('SHA манифеста не совпал')
    manifest = json.loads(manifest_body)
    if manifest.get('schema') != 1 or manifest.get('serverBaseSha256') != '7b60187397cb11fe7e382682fb65e5a1600b35255bf85c8bbdfe2b122c35d8a2':
        raise ValueError('Неверный пакет')
    entries = manifest['files']
    names = set()
    for entry in entries:
        name = entry['path']
        parts = pathlib.PurePosixPath(name).parts
        if not parts or name.startswith('/') or '\\' in name or any(p in ('.', '..') for p in parts) or name in names:
            raise ValueError('Неверный или повторный путь')
        if not re.fullmatch('[a-f0-9]{64}', entry['sha256']) or not 0 < entry['bytes'] <= 1024 * 1024:
            raise ValueError('Неверный размер или SHA')
        names.add(name)
    if sum(e['bytes'] for e in entries) > 4 * 1024 * 1024:
        raise ValueError('Пакет больше 4 МБ')

    def download(entry):
        dest = target.joinpath(*pathlib.PurePosixPath(entry['path']).parts)
        for parent in [dest.parent, *dest.parent.parents]:
            if parent.is_symlink():
                raise ValueError('Ссылка в целевом пути')
        if dest.exists():
            if not dest.is_file() or sha(dest.read_bytes()) != entry['sha256']:
                raise ValueError('Существующий файл отличается: ' + entry['path'])
            return
        body = get(base + entry['path'], entry['bytes'])
        if len(body) != entry['bytes'] or sha(body) != entry['sha256']:
            raise ValueError('Файл не совпал с манифестом: ' + entry['path'])
        dest.parent.mkdir(parents=True, exist_ok=True)
        with dest.open('xb') as handle:
            handle.write(body)

    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as executor:
        list(executor.map(download, entries))
    dest = target / 'BUILD_MANIFEST.json'
    if dest.exists():
        if sha(dest.read_bytes()) != args.manifest_sha:
            raise ValueError('Существующий манифест отличается')
    else:
        with dest.open('xb') as handle:
            handle.write(manifest_body)
    print(json.dumps({'downloaded_and_verified': len(entries), 'manifestSha256': args.manifest_sha, 'installed': False}))


if __name__ == '__main__':
    main()
