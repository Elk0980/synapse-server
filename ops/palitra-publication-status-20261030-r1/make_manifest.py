"""Local code-only manifest assembly. No network or production access.
Usage: make_manifest.py FRESH_BEFORE_COMPOSER FRESH_BEFORE_MATERIAL FRESH_BEFORE_TASKS FRESH_FIVE_IMAGES_JSON OUTPUT
Fresh files and image IDs must come from the new Root-owned native inspection.
The helper independently verifies actual live SHA/image IDs under its fresh lease.
SHOP is deliberately excluded: no unverified host-target argument is accepted.
"""
from pathlib import Path
import importlib.util,json,sys
sys.dont_write_bytecode=True
spec=importlib.util.spec_from_file_location('customer_static_release',Path(__file__).with_name('install.py'))
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
PINS=(('424bd6cba01ffffc614ce038cc2259662c19b4cdb5d5bf7b66cfc669d3e2bdcc', '7b4644c80a5dd897781785546eb46a80248d712ce9b7b392e09e9b96abda7dee'), ('bbec4408d0095e333aa1f04b5f194b3db788ad6dc3dd941bedbd837cf443473c', 'bdd14b406bea4df269d7d470c6060a337b872d1cf2f9ad715cf41f012ae47756'), ('ae5c439e036dd641b2c6f346792423102fe0f1b1dc28b9c96e082e9e2c6e0b49', '7152a476b4081717fde1eed4ef1bc409e3eb18f6f595c01d37b2a97d5a0361d7'))
def build(before_paths,images):
    m.need(len(before_paths)==3,'EXACT_THREE_FRESH_BEFORE_FILES_REQUIRED')
    rows=[]
    for target,before_path,pins in zip(m.SCOPE,before_paths,PINS):
        before_path=Path(before_path)
        after_path=Path(__file__).parent/'payload'/target
        for path in (before_path,after_path):
            m.need(not path.is_symlink() and path.resolve().is_file(),'CANONICAL_REVIEWED_FILES_REQUIRED')
        m.need(m.sha(before_path.read_bytes())==pins[0],'FRESH_INSTALLED_TARGET_SHA_REQUIRED')
        m.need(m.sha(after_path.read_bytes())==pins[1],'REVIEWED_AFTER_SHA_REQUIRED')
        rows.append({'target':target,'beforeSha256':pins[0],'afterSha256':pins[1]})
    return m.validate_manifest({'schema':1,'status':'ROOT_REVIEWED_CODE_ONLY','packageId':m.NAME,'helperSha256':m.sha(m.SELF.read_bytes()),'expectedImages':images,'targets':rows})
if __name__=='__main__':
    m.need(len(sys.argv)==6,'EXACT_FIVE_ARGUMENTS_REQUIRED')
    value=build(sys.argv[1:4],json.loads(Path(sys.argv[4]).read_bytes()))
    out=Path(sys.argv[5]);m.write_new(out,m.enc(value));print('MANIFEST_SHA256 '+m.sha(out.read_bytes()))
