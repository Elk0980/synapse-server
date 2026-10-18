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
CODE_NAME = 'palitra-chat-avatar-hugh-code-r1'
ZIP_SHA = '7c8a57bba0293e2c9a41353f2b88aa133b500bc2e0f0e58f455fc19ebb786505'
HELPER_SHA = '32993cd941a3d3e08369161f61dc7871b3252442f4fa0a9bc58631b87e113111'
WRAPPER_SHA = 'e18c93196e052ed3d656416b8ec2dc5c4be16f904dd31a1b66439662245015ca'
MANIFEST_SHA = 'c6b5d39cf1025f48d6169c070d3d3899dee14faa3c7eca899040a0dc6ae057bc'
MAX_ZIP = 4 * 1024 * 1024
MAX_TOTAL = 8 * 1024 * 1024
MAX_FILE = 2 * 1024 * 1024
SCOPE = 'EXACT_AVATAR_HUGH_SOURCE209_TO210_STATIC27_CHAIN29_TO30'
PRODUCT = {'shell.js', 'shell.css', 'synapse-bridge.js'}
PAYLOADS = {'backend/server.js', 'backend/palitra-host-adapter.cjs', 'backend/customer-chat-native-adapter.cjs', 'legacy/palitra-chat.js', 'product/synapse-bridge.js', 'product/shell.css', 'backend/palitra-staff-advisories.cjs', 'backend/customer-chat.js', 'product/shell.js', 'legacy/palitra-chat.css'}
BEFORE = {'product/shell.js': ('ce27d4e0223d80d7634783bf6b4b6db6faf8a200779cbecaf4ece7144cf4460b', 228685), 'product/shell.css': ('718953b3467ce683aaaf81851bd3bcf8d32b0d6eae5d7849632f42fba27533c5', 51634), 'product/synapse-bridge.js': ('4f12abbea2f5015622eb1bf2fe72cb268f5a88c02a45659ea510ee96d838c53e', 70679), 'backend/customer-chat.js': ('44e1792aec51dc72303d50a46cf6d72797bfa18d3c46900be7ba1b8899ba817d', 120601), 'backend/customer-chat-native-adapter.cjs': ('b49e0e836499bf1923e86c35f69fcb27819fdeca60807485be3749ac8c5937b1', 38034), 'backend/server.js': ('868cecae18b32a609285c49b40287d0d06769e727c53ca7de18348119507fc63', 124888), 'backend/palitra-host-adapter.cjs': ('0fba381d60f2657ea8ca1fbed63829da0faaf707013c5190d1c9f9bfb85764c2', 46693), 'legacy/palitra-chat.js': ('99fb1181fa78e045b33266d7d3dead3e5c58625771d32b242a127fd2fe0c0141', 64235), 'legacy/palitra-chat.css': ('00500fed94911202e55aaa355e63a659eac8154b74a07d6ae7cf30693639c00a', 7886)}

MEMBERS = {'chat_avatar_hugh_release_native.py', 'chat_avatar_hugh.py', 'payload/MANIFEST.json'} | {'payload/' + name for name in PAYLOADS}
URL_RE = r'https://raw\.githubusercontent\.com/Elk0980/synapse-server/[0-9a-f]{40}/ops/releases/palitra-chat-avatar-hugh-20261019/code-r1\.zip'
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
        need(len(rows) == len(MEMBERS) == 13 and len({row.filename for row in rows}) == 13
             and {row.filename for row in rows} == MEMBERS and sum(row.file_size for row in rows) <= MAX_TOTAL, 'EXACT_THIRTEEN_PACKET_MEMBERS_REQUIRED')
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
    need(files['chat_avatar_hugh_release_native.py'].count(("MANIFEST_SHA = '" + MANIFEST_SHA + "'").encode()) == 1
         and files['chat_avatar_hugh.py'].count(("HELPER_SHA = '" + HELPER_SHA + "'").encode()) == 1, 'EXACT_FROZEN_CODE_REFERENCES_REQUIRED')
    need(sha(files['chat_avatar_hugh_release_native.py']) == HELPER_SHA and sha(files['chat_avatar_hugh.py']) == WRAPPER_SHA
         and sha(files['payload/MANIFEST.json']) == MANIFEST_SHA, 'PACKET_CODE_OR_MANIFEST_PIN_CHANGED')
    manifest = json.loads(files['payload/MANIFEST.json'], object_pairs_hook=unique_object)
    need(type(manifest) is dict and set(manifest) == {'schema', 'status', 'records', 'staticModes'} and type(manifest['schema']) is int and manifest['schema'] == 1
         and manifest['status'] == SCOPE and type(manifest['records']) is list and len(manifest['records']) == 10
         and type(manifest['staticModes']) is dict and set(manifest['staticModes']) == PRODUCT
         and all(type(mode) is int for mode in manifest['staticModes'].values()) and manifest['staticModes'] == {'shell.js': 0o600, 'shell.css': 0o644, 'synapse-bridge.js': 0o600}, 'EXACT_PACKET_MANIFEST_REQUIRED')
    seen = set()
    for row in manifest['records']:
        if type(row) is dict and row.get('name') == 'backend/palitra-staff-advisories.cjs':
            need(set(row) == {'name', 'payload', 'sha256', 'bytes', 'added'} and row.get('added') is True and row['name'] not in seen
                 and row['payload'] == row['name'] and type(row['sha256']) is str and re.fullmatch('[0-9a-f]{64}', row['sha256'])
                 and type(row['bytes']) is int and 0 < row['bytes'] <= MAX_FILE, 'EXACT_ONE_ADDED_PACKET_MODULE_REQUIRED')
            value = files['payload/' + row['name']]
            need(len(value) == row['bytes'] and sha(value) == row['sha256'], 'EXACT_ADDED_PACKET_MODULE_BYTES_REQUIRED')
            seen.add(row['name']); continue
        need(type(row) is dict and set(row) == {'name', 'payload', 'beforeSha256', 'beforeBytes', 'sha256', 'bytes', 'hunks'}, 'EXACT_PACKET_RECORD_REQUIRED')
        name = row['name']
        need(type(name) is str and name in PAYLOADS and name not in seen and row['payload'] == name
             and all(type(row[key]) is str and re.fullmatch('[0-9a-f]{64}', row[key]) for key in ('beforeSha256', 'sha256'))
             and all(type(row[key]) is int and 0 < row[key] <= MAX_FILE for key in ('beforeBytes', 'bytes'))
             and type(row['hunks']) is list and 1 <= len(row['hunks']) <= 256, 'FIXED_PACKET_RECORD_REQUIRED')
        need((row['beforeSha256'], row['beforeBytes']) == BEFORE[name], 'EXACT_NATIVE30_EXISTING9_REQUIRED')
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
    for relative in ('payload', 'payload/backend', 'payload/product', 'payload/legacy'):
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
    need(found_files == MEMBERS and found_directories == {'payload', 'payload/backend', 'payload/product', 'payload/legacy'}, 'STAGED_PACKET_INVENTORY_CHANGED')
    for name, value in sorted(values.items()): guard(); files.verify(code / name, value)
    guard()
    return {'status': 'EXACT_CODE_PACKET_STAGED_NOT_APPLIED', 'members': 13, 'zipSha256': ZIP_SHA, 'helperSha256': HELPER_SHA,
            'wrapperSha256': WRAPPER_SHA, 'manifestSha256': MANIFEST_SHA, 'runtimeWrites': 0, 'dbWrites': 0, 'builds': 0, 'contentUps': 0}


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    try: frozen()
    except ValueError:
        print(json.dumps({'status': 'DRAFT_NOT_FROZEN_NO_NATIVE_ACTION', 'nativeActions': 0})); return 2
    need(os.name == 'posix' and hasattr(os, 'geteuid') and os.geteuid() == 0 and len(argv) == 1, 'NATIVE_ROOT_PACKET_INVOCATION_REQUIRED')
    result = stage(download(argv[0])); print(json.dumps(result)); return 0


if __name__ == '__main__': sys.exit(main())
