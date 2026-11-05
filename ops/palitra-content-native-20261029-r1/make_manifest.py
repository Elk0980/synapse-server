"""Local reviewed snapshot manifest builder. No network or production access.

Usage: make_manifest.py BEFORE_ROOT AFTER_ROOT FIVE_IMAGE_IDS_JSON OUTPUT_JSON
Snapshots contain full target relative paths, not stale full repository versions.
"""
from pathlib import Path
import importlib.util,json,os,sys
spec=importlib.util.spec_from_file_location('inline_release',Path(__file__).with_name('install.py'))
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)

def build(before,after,images):
    before=Path(before).resolve();after=Path(after).resolve();rows=[]
    for target in m.SCOPE:
        old=before/target;new=after/target
        if target in m.NEW:m.need(not os.path.lexists(old),'NEW_MUST_BE_ABSENT_IN_REVIEWED_BASE');pin=None
        else:
            m.need(old.resolve()==old and old.is_file() and not old.is_symlink(),'CANONICAL_BEFORE_SNAPSHOT');pin=m.sha(old.read_bytes())
        m.need(new.resolve()==new and new.is_file() and not new.is_symlink(),'CANONICAL_AFTER_SNAPSHOT');raw=new.read_bytes()
        rows.append({'target':target,'beforeSha256':pin,'afterSha256':m.sha(raw),'bytes':len(raw)})
    return m.validate_manifest({'schema':1,'packageId':m.NAME,'status':'ROOT_REVIEWED_CODE_ONLY','helperSha256':m.sha(m.SELF.read_bytes()),'expectedImages':images,'files':rows})

if __name__=='__main__':
    result=build(sys.argv[1],sys.argv[2],json.loads(Path(sys.argv[3]).read_bytes()))
    path=Path(sys.argv[4]);m.write_new(path,m.enc(result));print('MANIFEST_SHA256 '+m.sha(path.read_bytes()))
