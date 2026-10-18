"""Frozen code-only staging; never apply/build/up."""
from pathlib import Path, PurePosixPath
import hashlib
import base64
import io
import json
import os
import re
import stat
import sys
import urllib.request
import zipfile

ROOT = Path('/opt/synapse/releases/palitra-app-20261015')
CODE_NAME = 'palitra-checkout-direct-chat-code-r1'
ZIP_SHA = 'c141b6bad686c558295ac9ee5a3c14b235442d83cb33e6accccea4f043b86e49'
HELPER_SHA = '314d76f1bdbddcea6aa14ab6f0c9ddac432e9a502eef1f06ac39f682186fd9fb'
WRAPPER_SHA = 'c5ac25c55c626695b9a5928516516bc4dff3f7ed055c90d557cd11585ff34e31'
MANIFEST_SHA = 'af53d50c682a725b3e17f21489a37b75d663addb16d534fff08ccdc6956d2c48'
MAX_ZIP = 4 * 1024 * 1024
MAX_TOTAL = 8 * 1024 * 1024
MAX_FILE = 2 * 1024 * 1024
SCOPE = 'EXACT_CHECKOUT_SOURCE209_STATIC27_CHAIN27_TO_28'
PRODUCT = {'order.js'}
PAYLOADS = {'source/customer-chat-native-adapter.cjs', 'source/site-orders.js', 'source/native-contact-followup.cjs', 'source/customer-chat.js', 'customer/order.js'}
BEFORE = {'customer/order.js': ('468e43816e3ab1787dd9fff9861af1e08ca8c09060ed8a2141568e4edbd18223', 81971), 'source/customer-chat-native-adapter.cjs': ('5042cd673898e57aa8ea70db5c3b96a6f13ded65c54e88e14d51142395a7f3f6', 37323), 'source/customer-chat.js': ('a1f8d3430f62b7ed676bbe10a0a6a7a3fb33ab1feea6f80c0ee1f51cdf7bd9eb', 119550), 'source/native-contact-followup.cjs': ('d5b5a05111f4818d3beaef9ff421e9af6fc91549c3eadd641fc7dd6a8768f410', 14242), 'source/site-orders.js': ('da10aa8c05af59e50d4d75406dbff4c90a05837f7ede4831a2c3812d7018e51f', 55585)}

MEMBERS = {'checkout_direct_chat_release_native.py', 'checkout_direct_chat.py', 'payload/MANIFEST.json'} | {'payload/' + name for name in PAYLOADS}
URL_RE = r'https://raw\.githubusercontent\.com/Elk0980/synapse-server/[0-9a-f]{40}/ops/releases/palitra-checkout-direct-chat-20261019/code-r1\.zip'
sha = lambda raw: hashlib.sha256(raw).hexdigest()


def need(value, code):
    if not value: raise ValueError(code)


def frozen():
    need(all(type(pin) is str and re.fullmatch('[0-9a-f]{64}', pin) and pin != '0' * 64
             for pin in (ZIP_SHA, HELPER_SHA, WRAPPER_SHA, MANIFEST_SHA)), 'PACKET_NOT_FROZEN')


def exact(path, missing=False):
    path = Path(path)
    need(path.is_absolute() and '..' not in path.parts, 'ABSOLUTE_PACKET_PATH_REQUIRED')
    for item in [*reversed(path.parents), path]:
        try: row = item.lstat()
        except FileNotFoundError:
            need(missing and item == path, 'PACKET_PARENT_MISSING'); continue
        need(not stat.S_ISLNK(row.st_mode) and not (getattr(row, 'st_file_attributes', 0) & 0x400), 'PACKET_SYMLINK_REFUSED')
        if item != path: need(stat.S_ISDIR(row.st_mode), 'PACKET_PARENT_DIRECTORY_REQUIRED')
    return path


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ValueError('PACKET_REDIRECT_REFUSED')


def download(url, opener=None):
    frozen(); need(type(url) is str and re.fullmatch(URL_RE, url), 'EXACT_IMMUTABLE_PACKET_URL_REQUIRED')
    client = opener or urllib.request.build_opener(NoRedirect())
    with client.open(url, timeout=45) as response:
        need(response.status == 200 and response.url == url, 'EXACT_PACKET_RESPONSE_REQUIRED')
        raw = response.read(MAX_ZIP + 1)
    need(0 < len(raw) <= MAX_ZIP and sha(raw) == ZIP_SHA, 'BOUNDED_PINNED_PACKET_REQUIRED')
    return raw


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        need(key not in result, 'DUPLICATE_MANIFEST_KEY_REFUSED'); result[key] = value
    return result


def packet_files(raw):
    frozen(); need(type(raw) is bytes and 0 < len(raw) <= MAX_ZIP and sha(raw) == ZIP_SHA, 'BOUNDED_PINNED_PACKET_REQUIRED')
    files = {}
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        rows = archive.infolist()
        need(len(rows) == len(MEMBERS) == 8 and len({row.filename for row in rows}) == 8
             and {row.filename for row in rows} == MEMBERS and sum(row.file_size for row in rows) <= MAX_TOTAL, 'EXACT_EIGHT_PACKET_MEMBERS_REQUIRED')
        for row in rows:
            path = PurePosixPath(row.filename); kind = stat.S_IFMT(row.external_attr >> 16)
            need(not row.is_dir() and not path.is_absolute() and path.as_posix() == row.filename
                 and '..' not in path.parts and '\\' not in row.filename and ':' not in row.filename
                 and kind in (0, stat.S_IFREG) and not row.flag_bits & 1
                 and row.compress_type in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED)
                 and 0 < row.file_size <= MAX_FILE, 'REGULAR_BOUNDED_PACKET_MEMBER_REQUIRED')
            with archive.open(row) as stream:
                value = stream.read(MAX_FILE + 1)
                need(len(value) == row.file_size and not stream.read(1), 'PACKET_MEMBER_SIZE_CHANGED')
            files[row.filename] = value
    need(files['checkout_direct_chat_release_native.py'].count(("MANIFEST_SHA = '" + MANIFEST_SHA + "'").encode()) == 1
         and files['checkout_direct_chat.py'].count(("HELPER_SHA = '" + HELPER_SHA + "'").encode()) == 1, 'EXACT_FROZEN_CODE_REFERENCES_REQUIRED')
    need(sha(files['checkout_direct_chat_release_native.py']) == HELPER_SHA and sha(files['checkout_direct_chat.py']) == WRAPPER_SHA
         and sha(files['payload/MANIFEST.json']) == MANIFEST_SHA, 'PACKET_CODE_OR_MANIFEST_PIN_CHANGED')
    manifest = json.loads(files['payload/MANIFEST.json'], object_pairs_hook=unique_object)
    need(type(manifest) is dict and set(manifest) == {'schema', 'status', 'records', 'staticModes'} and type(manifest['schema']) is int and manifest['schema'] == 1
         and manifest['status'] == SCOPE and type(manifest['records']) is list and len(manifest['records']) == 5
         and type(manifest['staticModes']) is dict and set(manifest['staticModes']) == PRODUCT
         and all(type(mode) is int for mode in manifest['staticModes'].values()) and manifest['staticModes'] == {'order.js': 0o600}, 'EXACT_PACKET_MANIFEST_REQUIRED')
    seen = set()
    for row in manifest['records']:
        need(type(row) is dict and set(row) == {'name', 'payload', 'beforeSha256', 'beforeBytes', 'sha256', 'bytes', 'hunks'}, 'EXACT_PACKET_RECORD_REQUIRED')
        name = row['name']
        need(type(name) is str and name in PAYLOADS and name not in seen and row['payload'] == name
             and all(type(row[key]) is str and re.fullmatch('[0-9a-f]{64}', row[key]) for key in ('beforeSha256', 'sha256'))
             and all(type(row[key]) is int and 0 < row[key] <= MAX_FILE for key in ('beforeBytes', 'bytes'))
             and type(row['hunks']) is list and 1 <= len(row['hunks']) <= 256, 'FIXED_PACKET_RECORD_REQUIRED')
        need((row['beforeSha256'], row['beforeBytes']) == BEFORE[name], 'EXACT_NATIVE28_BASE_FIVE_REQUIRED')
        value = files['payload/' + name]
        need(len(value) == row['bytes'] and sha(value) == row['sha256'] and row['beforeSha256'] != row['sha256'], 'PACKET_PAYLOAD_PIN_CHANGED')
        old = value
        decoded = []
        for hunk in row['hunks']:
            need(type(hunk) is dict and set(hunk) == {'before', 'after'}
                 and all(type(hunk[k]) is str and 0 < len(hunk[k]) <= 3 * 1024 * 1024 for k in hunk), 'BOUNDED_BASE64_PACKET_HUNK_REQUIRED')
            pair = [base64.b64decode(hunk[k], validate=True) for k in ('before', 'after')]
            need(all(0 < len(v) <= MAX_FILE and base64.b64encode(v).decode('ascii') == hunk[k]
                     for k, v in zip(('before', 'after'), pair)) and pair[0] != pair[1], 'CANONICAL_PACKET_BYTE_HUNK_REQUIRED')
            decoded.append(pair)
        for before, after in reversed(decoded):
            need(old.count(after) == 1, 'UNIQUE_REVERSE_PACKET_HUNK_REQUIRED'); old = old.replace(after, before, 1)
        need(len(old) == row['beforeBytes'] and sha(old) == row['beforeSha256'], 'EXACT_PACKET_BEFORE_BYTES_REQUIRED')
        for before, after in decoded:
            need(old.count(before) == 1, 'UNIQUE_FORWARD_PACKET_HUNK_REQUIRED'); old = old.replace(before, after, 1)
        need(old == value, 'EXACT_PACKET_AFTER_BYTES_REQUIRED'); seen.add(name)
    need(seen == PAYLOADS, 'EXACT_PACKET_PAYLOADS_REQUIRED')
    return files


class PrivateFiles:
    def mode(self, fd): return stat.S_IMODE(os.fstat(fd).st_mode)
    def set_mode(self, fd, mode):
        need(os.name == 'posix' and hasattr(os, 'fchmod'), 'POSIX_PACKET_FCHMOD_REQUIRED'); os.fchmod(fd, mode)
    def facts(self, path):
        path = exact(path); row = path.stat()
        need(stat.S_ISDIR(row.st_mode) and row.st_uid == 0, 'ROOT_PACKET_PARENT_REQUIRED')
        return (row.st_dev, row.st_ino, row.st_uid, stat.S_IMODE(row.st_mode))
    def directory(self, path):
        path = exact(path, True); need(not os.path.lexists(path), 'NEW_PACKET_DIRECTORY_REQUIRED'); path.mkdir(mode=0o700)
        flags = os.O_RDONLY | getattr(os, 'O_DIRECTORY', 0) | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_CLOEXEC', 0)
        fd = os.open(path, flags)
        try:
            first = os.fstat(fd); need(stat.S_ISDIR(first.st_mode) and first.st_uid == 0 and not os.listdir(path), 'EMPTY_ROOT_PACKET_DIRECTORY_REQUIRED')
            self.set_mode(fd, 0o700); os.fsync(fd); last = os.fstat(fd); actual = exact(path).stat()
            need((first.st_dev, first.st_ino, first.st_uid) == (last.st_dev, last.st_ino, last.st_uid) == (actual.st_dev, actual.st_ino, actual.st_uid)
                 and self.mode(fd) == 0o700, 'PRIVATE_PACKET_DIRECTORY_READBACK_FAILED')
        finally: os.close(fd)
    def write(self, path, raw):
        path = exact(path, True); need(not os.path.lexists(path), 'NEW_PACKET_FILE_REQUIRED')
        flags = os.O_RDWR | os.O_CREAT | os.O_EXCL | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_CLOEXEC', 0) | getattr(os, 'O_BINARY', 0)
        fd = os.open(path, flags, 0o600)
        try:
            first = os.fstat(fd); need(stat.S_ISREG(first.st_mode) and first.st_uid == 0, 'REGULAR_ROOT_PACKET_FILE_REQUIRED')
            view = memoryview(raw)
            while view:
                count = os.write(fd, view); need(count > 0, 'PACKET_WRITE_INCOMPLETE'); view = view[count:]
            self.set_mode(fd, 0o600); os.fsync(fd); self.readback(fd, path, raw, first)
        finally: os.close(fd)
    def readback(self, fd, path, raw, first):
        need(stat.S_ISREG(first.st_mode) and first.st_uid == 0 and first.st_size in (0, len(raw)), 'REGULAR_ROOT_PACKET_FILE_REQUIRED')
        os.lseek(fd, 0, os.SEEK_SET); digest = hashlib.sha256(); total = 0
        while True:
            part = os.read(fd, 65536)
            if not part: break
            total += len(part); need(total <= len(raw), 'PACKET_FILE_SIZE_CHANGED'); digest.update(part)
        last = os.fstat(fd); actual = exact(path).stat()
        need((first.st_dev, first.st_ino, first.st_uid) == (last.st_dev, last.st_ino, last.st_uid) == (actual.st_dev, actual.st_ino, actual.st_uid)
             and self.mode(fd) == 0o600 and total == len(raw) and digest.hexdigest() == sha(raw), 'PRIVATE_PACKET_FILE_READBACK_FAILED')
    def verify(self, path, raw):
        path = exact(path)
        flags = os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_CLOEXEC', 0) | getattr(os, 'O_BINARY', 0)
        fd = os.open(path, flags)
        try: self.readback(fd, path, raw, os.fstat(fd))
        finally: os.close(fd)


def stage(raw, root=ROOT, files=None):
    """Local bytes only. Root uses default native implementation; tests use temp roots."""
    frozen(); root = Path(root); need(files is None or root != ROOT, 'NATIVE_PACKET_FILE_OPS_REQUIRED'); files = files or PrivateFiles()
    values = packet_files(raw); root = exact(root); code = root / CODE_NAME
    need(not os.path.lexists(code), 'PACKET_NAMESPACE_ALREADY_EXISTS')
    parents = {str(path): files.facts(path) for path in [*reversed(root.parents), root]}
    def guard():
        need(all(files.facts(Path(path)) == facts for path, facts in parents.items()), 'PACKET_PARENT_IDENTITY_CHANGED')
    guard(); files.directory(code); parents[str(code)] = files.facts(code)
    for relative in ('payload', 'payload/customer', 'payload/source'):
        guard(); path = code / relative; files.directory(path); parents[str(path)] = files.facts(path)
    for name, value in sorted(values.items()):
        guard(); files.write(code / name, value)
    guard()
    found_files, found_directories = set(), set()
    for path in code.rglob('*'):
        exact(path); name = path.relative_to(code).as_posix()
        if path.is_file(): found_files.add(name)
        else:
            need(path.is_dir(), 'REGULAR_STAGED_PACKET_ENTRY_REQUIRED'); found_directories.add(name)
    need(found_files == MEMBERS and found_directories == {'payload', 'payload/customer', 'payload/source'}, 'STAGED_PACKET_INVENTORY_CHANGED')
    for name, value in sorted(values.items()): guard(); files.verify(code / name, value)
    guard()
    return {'status': 'EXACT_CODE_PACKET_STAGED_NOT_APPLIED', 'members': 8, 'zipSha256': ZIP_SHA, 'helperSha256': HELPER_SHA,
            'wrapperSha256': WRAPPER_SHA, 'manifestSha256': MANIFEST_SHA, 'runtimeWrites': 0, 'dbWrites': 0, 'builds': 0, 'contentUps': 0}


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    try: frozen()
    except ValueError:
        print(json.dumps({'status': 'DRAFT_NOT_FROZEN_NO_NATIVE_ACTION', 'nativeActions': 0})); return 2
    need(os.name == 'posix' and hasattr(os, 'geteuid') and os.geteuid() == 0 and len(argv) == 1, 'NATIVE_ROOT_PACKET_INVOCATION_REQUIRED')
    result = stage(download(argv[0])); print(json.dumps(result)); return 0


if __name__ == '__main__': sys.exit(main())
