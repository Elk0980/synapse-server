#!/usr/bin/env python3
"""478: только чтение совместимости публичных hunks с действующим runtime.

Не запускает выпуск и не берёт блокировку. Пробник не пишет runtime и не выводит actual source/env.
После проверки разрешены один redacted receipt и идемпотентный отчёт в задачу35.
Все кандидаты строятся исключительно из публичных before/after. Симуляция — только память.
Индексы rule/edit/atomic/candidate/line нулевые; контексты измеряются строками.
"""
from pathlib import Path,PurePosixPath
import copy,difflib,hashlib,json,os,stat,subprocess as sp,sys
P=Path('/opt/synapse/releases/tasks-mcp-20261103-r1')
N=P/'release-478-35-r2'
PACKAGE=N/'package478'
LOCK='/opt/synapse/.palitra-app-release.lock'
HEAD='7cfe5a474a7a59bb7f19afc76e314ae4359a6d15'
MANIFEST_SHA='d5b8f1081c11b35e7e7051f8cec1ff68786a2a30ec2a7e51e15ab379899cec54'
MODIFIED={'ops/content/auth-store.js','ops/content/company-team.js','ops/content/server.js','ops/crm/server.js','ops/crm/task-coordination.js'}
CONTEXTS=[(3,3),(3,2),(2,3),(2,2),(3,1),(1,3),(2,1),(1,2),(1,1),(3,0),(0,3),(2,0),(0,2),(1,0),(0,1),(0,0)]
class Refusal(Exception):pass
def need(value,code):
    if not value:raise Refusal(code)
def sha(value):return hashlib.sha256(value).hexdigest()
def canonical(value):return json.dumps(value,ensure_ascii=False,sort_keys=True,separators=(',',':')).encode()
def lf(value):return value.replace('\r\n','\n')
def output(label,value):print(label,json.dumps(value,ensure_ascii=False,separators=(',',':')),flush=True)
def regular(path,directory=False):
    path=Path(path);need(path.is_absolute() and not any(p.is_symlink() for p in [path,*path.parents]),'UNSAFE_PATH')
    st=path.stat();need(stat.S_ISDIR(st.st_mode) if directory else stat.S_ISREG(st.st_mode),'FILE_TYPE')
    return path

def load(path):return json.loads(regular(path).read_bytes())
def command(args):
    try:r=sp.run(args,capture_output=True,timeout=90)
    except sp.TimeoutExpired:raise Refusal('READ_TIMEOUT') from None
    need(r.returncode==0,'READ_COMMAND_FAILED');return r.stdout

def lock_free():
    rows=json.loads(command(['lslocks','--json','-o','PID,PATH'])).get('locks',[])
    free=not any(row.get('path')==LOCK for row in rows);need(free,'ANOTHER_WRITER_LOCK_HELD');return free

def env_map(row):
    result={}
    for pair in row['Config'].get('Env') or []:
        key,sep,value=pair.partition('=');need(sep and key not in result,'ENV_AMBIGUOUS');result[key]=value
    return result

def mounts(row):return sorted(row.get('Mounts',[]),key=lambda m:(m.get('Destination',''),m.get('Source',''),m.get('Type','')))
def networks(row):return {k:v.get('NetworkID') for k,v in row['NetworkSettings']['Networks'].items()}
def fact(row):
    return {'Id':row['Id'],'Image':row['Image'],'StartedAt':row['State']['StartedAt'],'RestartCount':row['RestartCount'],
        'Running':row['State']['Running'],'Env':sha(canonical(env_map(row))),'Mounts':sha(canonical(mounts(row))),
        'Networks':sha(canonical(networks(row))),'Config':sha(canonical(row['Config']))}

def baseline(before):
    ids=command(['docker','ps','-q','--no-trunc']).decode().split();need(ids,'NO_RUNNING_CONTAINERS')
    current=json.loads(command(['docker','inspect',*ids]));old={r['Id']:r for r in before};now={r['Id']:r for r in current}
    need(set(old)==set(now),'RUNNING_CONTAINER_SET_CHANGED')
    need(all(fact(old[i])==fact(now[i]) for i in old),'NORMALIZED_BASELINE_CHANGED')
    summary=[]
    for name in ['synapse-crm-1','synapse-content-1','synapse-tasks-mcp-1']:
        pair=[(old[i],now[i]) for i in old if old[i]['Name']=='/'+name];need(len(pair)==1,'TARGET_IDENTITY')
        a,b=pair[0];summary.append({'service':name,'same_id':a['Id']==b['Id'],'same_image':a['Image']==b['Image'],
            'same_started':a['State']['StartedAt']==b['State']['StartedAt'],'same_restarts':a['RestartCount']==b['RestartCount'],
            'same_config':a['Config']==b['Config'],'same_env':env_map(a)==env_map(b),'same_normalized_mounts':mounts(a)==mounts(b),
            'same_networks':networks(a)==networks(b),'running':b['State']['Running']})
    return {r['Name']:r for r in current},summary

def public_candidates(edit):
    """Пары atom/window создаются только из опубликованных строк; actual не участвует."""
    a=edit['before'].splitlines(keepends=True);b=edit['after'].splitlines(keepends=True)
    opcodes=difflib.SequenceMatcher(None,a,b,autojunk=False).get_opcodes();result=[]
    for op_index,(tag,i1,i2,j1,j2) in enumerate(opcodes):
        if tag=='equal':continue
        left=opcodes[op_index-1] if op_index else None;right=opcodes[op_index+1] if op_index+1<len(opcodes) else None
        max_left=left[2]-left[1] if left and left[0]=='equal' else 0
        max_right=right[2]-right[1] if right and right[0]=='equal' else 0
        variants=[];seen=set()
        for wanted_left,wanted_right in CONTEXTS:
            l,r=min(wanted_left,max_left),min(wanted_right,max_right)
            if (l,r) in seen or tag=='insert' and l==r==0:continue
            seen.add((l,r));old=''.join(a[i1-l:i2+r]);new=''.join(a[i1-l:i1]+b[j1:j2]+a[i2:i2+r])
            need(old and old!=new,'INVALID_PUBLIC_ATOMIC_PAIR')
            variants.append({'index':len(variants),'left':l,'right':r,'before':old,'after':new})
        result.append({'index':len(result),'opcode_index':op_index,'tag':tag,'a':[i1,i2],'b':[j1,j2],'candidates':variants})
    return result

def counts(value,before,after):return [value.count(before),value.count(after),lf(value).count(lf(before)),lf(value).count(lf(after))]

def narrow_simulation(value,rule):
    original=value;current=value;applied=[];records=[];complete=True;first_failure=None
    for edit_index,edit in enumerate(rule['edits']):
        need(sha(edit['before'].encode())==edit['before_sha256'] and sha(edit['after'].encode())==edit['after_sha256'],'PUBLIC_EDIT_PIN')
        # Полный after уже установлен: не разрешаем искать слабый повторный якорь.
        whole_after=current.count(edit['after'])
        for atom in public_candidates(edit):
            variants=[];selected=None;after_seen=whole_after>0
            for c in atom['candidates']:
                measure=counts(current,c['before'],c['after'])
                variants.append([c['index'],c['left'],c['right'],*measure])
                if selected is None and not after_seen:
                    if measure[1]>0:after_seen=True
                    elif measure[0]==1:selected=c
            chosen=None
            if complete and selected is not None and not after_seen:
                current=current.replace(selected['before'],selected['after'],1);applied.append((selected['before'],selected['after']))
                chosen={'index':selected['index'],'before_sha256':sha(selected['before'].encode()),'after_sha256':sha(selected['after'].encode())}
            elif complete:
                complete=False;first_failure={'edit':edit_index,'atomic':atom['index'],'after_seen_no_fallback':after_seen}
            records.append({'edit':edit_index,'atomic':atom['index'],'opcode':atom['opcode_index'],'tag':atom['tag'],
                'public_a_lines':atom['a'],'public_b_lines':atom['b'],'candidates':variants,'selected':chosen,'blocked_after_failure':not complete})
    reverse=current
    for before,after in reversed(applied):
        need(reverse.count(after)==1,'NARROW_REVERSE_NOT_UNIQUE');reverse=reverse.replace(after,before,1)
    need(reverse==original,'NARROW_REVERSE_MISMATCH')
    return {'complete':complete,'first_failure':first_failure,'reverse_exact':True,'input_sha256':sha(original.encode()),
        'simulated_sha256':sha(current.encode()),'applied_count':len(applied),'records':records},applied

def public_proof(before,expected,pairs,complete):
    current=before
    for old,new in pairs:
        if current.count(old)!=1 or current.count(new)!=0:return {'complete':False,'exact':False,'reason':'PUBLIC_PAIR_NOT_UNIQUE'}
        current=current.replace(old,new,1)
    reverse=current
    for old,new in reversed(pairs):
        if reverse.count(new)!=1:return {'complete':False,'exact':False,'reason':'PUBLIC_REVERSE_NOT_UNIQUE'}
        reverse=reverse.replace(new,old,1)
    return {'complete':complete,'exact':complete and current==expected,'reverse_exact':reverse==before,
        'input_sha256':sha(before.encode()),'expected_sha256':sha(expected.encode()),'simulated_sha256':sha(current.encode())}

def full_simulation(value,rule):
    result=[];current=value;first_failure=None
    for index,e in enumerate(rule['edits']):
        measure=counts(value,e['before'],e['after']);sequential=counts(current,e['before'],e['after'])
        result.append({'edit':index,'raw_and_lf':measure,'sequential_raw_and_lf':sequential,
            'before_sha256':e['before_sha256'],'after_sha256':e['after_sha256'],
            'public_before_line_counts':[[value.count(line),lf(value).count(lf(line))] for line in e['before'].splitlines(keepends=True)]})
        if first_failure is None:
            if sequential[0]!=1 or sequential[1]!=0:first_failure=index
            else:current=current.replace(e['before'],e['after'],1)
    return result,first_failure

def prepared_names(rules):
    allowed={r['service']+'/'+Path(r['target']).name for r in rules['files']};folder=N/'source'
    names=[];unknown=0
    if folder.exists():
        regular(folder,directory=True)
        for path in folder.rglob('*'):
            need(not path.is_symlink(),'PREPARED_SOURCE_SYMLINK')
            if not path.is_file():continue
            relative=path.relative_to(folder).as_posix()
            if relative in allowed:names.append(relative)
            else:unknown+=1
    return {'known_filenames':sorted(names),'other_file_count':unknown}


def report_receipt(receipt):
    # Полный redacted JSON хранится приватно; в комментарий идут выбранные публичные индексы.
    compact={k:receipt[k] for k in ['first_original_failed_rule','modified_files','atomic_operations','all_narrow_complete',
        'source_probe_readonly','report_comment_write','normalized_baseline_still_unchanged','lock_free']}
    compact['files']=[]
    for file in receipt['files']:
        row={k:file[k] for k in ['rule','path','live_sha256','bytes','crlf_count']}
        row['edits']=[[e['edit'],e['raw_and_lf'],e['sequential_raw_and_lf'],e['public_before_line_counts']] for e in file['full_edits']]
        n=file['narrow'];row['narrow']={'complete':n['complete'],'reverse_exact':n['reverse_exact'],'first_failure':n['first_failure'],'atoms':[]}
        for atom in n['records']:
            chosen=atom['selected'];selected_counts=next((v for v in atom['candidates'] if chosen and v[0]==chosen['index']),None)
            row['narrow']['atoms'].append([atom['edit'],atom['atomic'],atom['opcode'],atom['tag'],atom['public_a_lines'],atom['public_b_lines'],
                [chosen['index'],chosen['before_sha256'],chosen['after_sha256'],selected_counts] if chosen else None])
        row['proofs']={tag:{k:v for k,v in proof.items() if k not in ['input_sha256','expected_sha256','simulated_sha256']} for tag,proof in file['public_proofs'].items()}
        compact['files'].append(row)
    text='R478_HUNK_DIAG_R2\n'+canonical(compact).decode();too_long=len(text)>9000
    receipt['report_text']=text if not too_long else 'REPORT_PENDING_COMPACT_LIMIT'
    target=N/'hunk-diagnostic.redacted.json'
    with target.open('xb') as out:
        out.write(canonical(receipt)+b'\n');out.flush();os.fsync(out.fileno())
    target.chmod(0o600)
    if too_long:
        print('R478H_REPORT_PENDING_COMPACT_LIMIT_RECEIPT_SAVED',flush=True);return
    try:
        result=sp.run(['docker','exec','-i','synapse-tasks-mcp-1','node','-e',COMMENT_JS],
            input=canonical({'marker':'R478_HUNK_DIAG_R2','text':text}),capture_output=True,timeout=120)
        need(result.returncode==0,'COMMENT_UNKNOWN');value=json.loads(result.stdout)
        need(isinstance(value.get('comment_id'),int),'COMMENT_UNKNOWN')
        output('R478H_REPORT',{'comment_id':value['comment_id'],'status':value['status'],'source_probe_readonly':True,'report_comment_write':True})
    except Exception:
        print('R478H_REPORT_PENDING_READ_TASK35_BEFORE_REPORT_ONLY_RETRY',flush=True)


def main():
    need(sys.platform.startswith('linux') and os.geteuid()==0,'NATIVE_ROOT_ONLY')
    need(command(['hostname']).decode().strip()=='msk-1-vm-tgnt','HOST_MISMATCH');lock_free();regular(N,directory=True)
    need(not (N/'hunk-diagnostic.redacted.json').exists() and not (N/'hunk-diagnostic.redacted.json').is_symlink(),'ALREADY_CAPTURED_REPORT_ONLY')
    sealed=load(N/'snapshot.sealed.json');need(sealed.get('ready') is True and sealed.get('metadata_only') is True,'SEALED_METADATA_REQUIRED')
    for name,digest in sealed['files'].items():
        need(len(PurePosixPath(name).parts)==1 and not PurePosixPath(name).is_absolute() and name not in ['.','..'],'SEALED_PATH')
        need(sha(regular(N/name).read_bytes())==digest,'SEALED_FILE_CHANGED')
    manifest_bytes=regular(PACKAGE/'manifest.json').read_bytes();need(sha(manifest_bytes)==MANIFEST_SHA,'MANIFEST_PIN')
    manifest=json.loads(manifest_bytes);need(manifest['approved_head']==HEAD,'HEAD_PIN')
    artifact={a['path']:a for a in manifest['artifacts']};hunk_bytes=regular(PACKAGE/'runtime-hunks.json').read_bytes()
    need(sha(hunk_bytes)==artifact['runtime-hunks.json']['sha256'],'HUNKS_PIN');rules=json.loads(hunk_bytes)
    changed=[r for r in rules['files'] if r.get('edits')];need({r['path'] for r in changed}==MODIFIED and len(changed)==5,'EXACT_FIVE_MODIFIED_REQUIRED')
    metadata=load(N/'metadata.redacted.json');before=load(N/'containers.private.json');current,summary=baseline(before)
    output('R478H_BASELINE',summary)
    guards={}
    for path,expected in metadata['guards'].items():
        p=regular(path);st=p.stat();guards[path]=sha(p.read_bytes())==expected['sha256'] and st.st_uid==expected['uid'] and st.st_gid==expected['gid'] and stat.S_IMODE(st.st_mode)==expected['mode']
    output('R478H_GUARDS',guards);need(len(guards)==5 and all(guards.values()),'GUARD_CHANGED')
    late=['source-plan.private.json','candidate.json','online-trial','cold-raw','cold-trial','actual-post','actual-post-fingerprints.private.json',
        'verified.native.redacted.json','release-plan.private.json','rollback.json','source/crm/Dockerfile','source/content/Dockerfile']
    present={name:(N/name).exists() or (N/name).is_symlink() for name in late};output('R478H_LATE_ARTIFACTS',present)
    need(not any(present.values()),'LATE_RELEASE_STAGE_PRESENT');output('R478H_PREPARED',prepared_names(rules));lock_free()
    first=None;all_narrow=True;total_atoms=0;file_reports=[]
    for rule_index,rule in enumerate(rules['files']):
        if not rule.get('edits'):continue
        need(rule['path'] in MODIFIED and rule['target']=='/app/'+Path(rule['path']).name and rule['service'] in ['crm','content'],'SOURCE_SCOPE')
        row=current['/synapse-'+rule['service']+'-1'];raw=command(['docker','exec',row['Id'],'cat',rule['target']])
        need(len(raw)<8*1024**2,'SOURCE_SIZE');value=raw.decode('utf-8')
        full,failed=full_simulation(value,rule)
        if first is None and failed is not None:first={'rule':rule_index,'path':rule['path'],'edit':failed}
        narrow,pairs=narrow_simulation(value,rule);total_atoms+=len(narrow['records']);all_narrow=all_narrow and narrow['complete']
        proofs={}
        for tag,before_root,after_root in [('public_base','review/public-base/','review/approved-head/'),('merged475476','review/merged475476/','review/combined-public/')]:
            a_path=before_root+rule['path'];b_path=after_root+rule['path'];need(a_path in artifact and b_path in artifact,'PUBLIC_PROOF_PAYLOAD_MISSING')
            a=regular(PACKAGE/a_path).read_bytes();b=regular(PACKAGE/b_path).read_bytes()
            need(sha(a)==artifact[a_path]['sha256'] and sha(b)==artifact[b_path]['sha256'],'PUBLIC_PROOF_PAYLOAD_PIN')
            proofs[tag]=public_proof(a.decode(),b.decode(),pairs,narrow['complete'])
        file_report={'rule':rule_index,'path':rule['path'],'live_sha256':sha(raw),'bytes':len(raw),'crlf_count':raw.count(b'\r\n'),
            'lf_normalized_sha256':sha(lf(value).encode()),'full_edits':full,'first_full_failure':failed,'narrow':narrow,'public_proofs':proofs}
        file_reports.append(file_report);output('R478H_FILE',{k:file_report[k] for k in ['rule','path','live_sha256','bytes','crlf_count','first_full_failure']})
        del raw,value,pairs
    baseline(before);lock_free()
    output('R478H_DONE',{'first_original_failed_rule':first,'modified_files':5,'atomic_operations':total_atoms,
        'all_narrow_complete':all_narrow,'normalized_baseline_still_unchanged':True,'lock_free':True,
        'runtime_source_written_or_exported':False,'source_text_printed':False,'source_probe_readonly':True,'report_comment_write':True,'native_release_executed':False})
    report_receipt({'source_sha256':sha(regular(Path(__file__).resolve()).read_bytes()),'source_probe_readonly':True,'report_comment_write':True,
        'normalized_baseline_still_unchanged':True,'lock_free':True,'guards':guards,'late_artifacts':present,
        'prepared':prepared_names(rules),'first_original_failed_rule':first,'modified_files':5,'atomic_operations':total_atoms,
        'all_narrow_complete':all_narrow,'files':file_reports,'source_text_printed':False,'runtime_source_written_or_exported':False,'native_release_executed':False})

COMMENT_JS="const fs=require('node:fs');const {loadConfig,crmClient}=require('/app/server.js');(async()=>{const input=JSON.parse(fs.readFileSync(0,'utf8')),call=crmClient(loadConfig());let offset=0;for(;;){const task=await call('task_get',{task_id:35,comments_limit:20,comments_offset:offset,subtasks_limit:1});const found=task.comments.find(c=>c.text.includes(input.marker));if(found){if(found.author!=='Codex — Выпуск PR478/#35'||found.text!==input.text)throw Error('MARKER');console.log(JSON.stringify({comment_id:found.id,status:'ALREADY_POSTED'}));return;}offset+=task.comments.length;if(offset>=task.comments_pagination.total)break;if(!task.comments.length)throw Error('PAGE');}const r=await call('task_comment',{task_id:35,author:'Codex — Выпуск PR478/#35',text:input.text});if(!Number.isSafeInteger(r.comment?.id))throw Error('COMMENT');console.log(JSON.stringify({comment_id:r.comment.id,status:'POSTED'}));})().catch(()=>{console.error('COMMENT_RESULT_UNKNOWN_READ_BEFORE_RETRY');process.exitCode=1;});"

if __name__=='__main__':
    try:main()
    except Exception as e:
        code=str(e) if isinstance(e,Refusal) else 'PRIVATE_INPUT_INSPECTION_REQUIRED'
        print('R478H_STOP_'+code,flush=True);sys.exit(1)
