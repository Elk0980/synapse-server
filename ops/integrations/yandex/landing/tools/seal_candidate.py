"""Read candidate files and write a SHA inventory inside landing/ only."""
from pathlib import Path
import hashlib
import json

root = Path(__file__).resolve().parents[1]
target = root / 'CANDIDATE_MANIFEST.json'
files = [p for p in root.rglob('*') if p.is_file() and p != target and '__pycache__' not in p.parts]
result = {
    'schema': 'avokado-yandex-landing-candidate/v1',
    'deployed': False,
    'files': [{'path': p.relative_to(root).as_posix(), 'bytes': p.stat().st_size,
               'sha256': hashlib.sha256(p.read_bytes()).hexdigest()} for p in sorted(files)],
}
target.write_bytes((json.dumps(result, ensure_ascii=False, indent=2) + '\n').encode('utf-8'))
print(json.dumps({'candidateFiles': len(files), 'manifestSha256': hashlib.sha256(target.read_bytes()).hexdigest()}))
