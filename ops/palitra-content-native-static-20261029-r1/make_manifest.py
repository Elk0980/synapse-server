"""Local flat reviewed snapshots -> closed static-only manifest. No network/DB.

Usage: make_manifest.py INLINE_BASELINE INLINE_MERGED FIVE_IMAGE_IDS_JSON OUTPUT_JSON
Snapshot folders contain filenames directly, as used by Root's current task.
"""
from pathlib import Path
import importlib.util,json,os,sys
sys.dont_write_bytecode=True
spec=importlib.util.spec_from_file_location('static_release',Path(__file__).with_name('install.py'))
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)

def build(before,after,images):
    before,after=Path(before).resolve(),Path(after).resolve();rows=[]
    for target in m.SCOPE:
        old,new=before/Path(target).name,after/Path(target).name
        if target in m.NEW:m.need(not os.path.lexists(old),'NEW_MUST_BE_ABSENT_IN_BASELINE');pin=None
        else:
            m.need(old.resolve()==old and old.is_file() and not old.is_symlink(),'CANONICAL_BASELINE_FILE');pin=m.sha(old.read_bytes())
        m.need(new.resolve()==new and new.is_file() and not new.is_symlink(),'CANONICAL_MERGED_FILE')
        rows.append({'target':target,'beforeSha256':pin,'afterSha256':m.sha(new.read_bytes())})
    return m.validate_manifest({'schema':1,'status':'ROOT_REVIEWED_CODE_ONLY','packageId':m.NAME,'helperSha256':m.sha(m.SELF.read_bytes()),'expectedImages':images,'targets':rows})

if __name__=='__main__':
    value=build(sys.argv[1],sys.argv[2],json.loads(Path(sys.argv[3]).read_bytes()));out=Path(sys.argv[4]);m.write_new(out,m.enc(value));print('MANIFEST_SHA256 '+m.sha(out.read_bytes()))
