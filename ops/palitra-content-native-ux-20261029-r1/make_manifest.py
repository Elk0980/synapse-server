"""Local reviewed one-file UX snapshots; no network, database or production access.

Usage: make_manifest.py BEFORE_MATERIAL_JS AFTER_MATERIAL_JS FIVE_IMAGES_JSON OUTPUT
"""
from pathlib import Path
import importlib.util,json,sys
sys.dont_write_bytecode=True
spec=importlib.util.spec_from_file_location('ux_static_release',Path(__file__).with_name('install.py'))
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
EXPECTED_BEFORE='ba47239741cf85a7b5e70c733acf794ddb68f6ee6e92cc0734432dde47344e8c'

def build(before,after,images):
    before,after=Path(before).resolve(),Path(after).resolve()
    m.need(before.is_file() and not before.is_symlink() and after.is_file() and not after.is_symlink(),'CANONICAL_REVIEWED_FILES')
    m.need(m.sha(before.read_bytes())==EXPECTED_BEFORE,'FRESH_INSTALLED_STATIC9_MATERIAL_BASE_REQUIRED')
    row={'target':m.SCOPE[0],'beforeSha256':EXPECTED_BEFORE,'afterSha256':m.sha(after.read_bytes())}
    return m.validate_manifest({'schema':1,'status':'ROOT_REVIEWED_CODE_ONLY','packageId':m.NAME,'helperSha256':m.sha(m.SELF.read_bytes()),'expectedImages':images,'targets':[row]})

if __name__=='__main__':
    value=build(sys.argv[1],sys.argv[2],json.loads(Path(sys.argv[3]).read_bytes()));out=Path(sys.argv[4]);m.write_new(out,m.enc(value));print('MANIFEST_SHA256 '+m.sha(out.read_bytes()))
