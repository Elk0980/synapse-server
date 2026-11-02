"""Closed, read-only inspection for the explicitly authorized Palitra release.

No application writes, database writes, leases, backups, build, restart or send.
The appended PATCH_SPEC is generated from the reviewed feature commit.
"""
import hashlib
import json
import os
import pathlib
import re
import stat
import subprocess

CONTAINER = "synapse-crm-1"
# Discovery only. An installer must bind the full machine-read identity emitted here.
IMAGE_PREFIX = "sha256:b74d9196617c"
PROVIDER_BEFORE = "8766f943728f91dfc511983127b077221748bb575396a27f483a02aaa0a36209"
TRANSPORT = "c658463a093f9ffd9c45a3b2fdd8fce321b72bd3384d9bac7143963b0db396a7"


class Refused(Exception):
    pass


def require(value, code):
    if not value:
        raise Refused(code)


def run(label, args, data=None):
    result = subprocess.run(args, input=data, capture_output=True, timeout=30)
    require(result.returncode == 0, label + "_FAILED")
    require(len(result.stdout) < 1024 * 1024, label + "_OVERSIZED")
    return result.stdout


def digest(data):
    return hashlib.sha256(data).hexdigest()


def rebase(source, spec):
    require(isinstance(spec.get("actualRuntimeBeforeSha256"), str) and
            re.fullmatch(r"[a-f0-9]{64}", spec["actualRuntimeBeforeSha256"]), "FULL_PIN_REQUIRED")
    require(digest(source) == spec["actualRuntimeBeforeSha256"], "CORE_CHANGED")
    text = source.decode("utf-8")
    for change in spec["patches"]:
        require(text.count(change["before"]) == 1, "PATCH_CONTEXT_NOT_UNIQUE")
        text = text.replace(change["before"], change["after"], 1)
    restored = text
    for change in reversed(spec["patches"]):
        require(restored.count(change["after"]) == 1, "PATCH_REVERSE_NOT_UNIQUE")
        restored = restored.replace(change["after"], change["before"], 1)
    require(restored.encode("utf-8") == source, "UNRELATED_SOURCE_CHANGED")
    return text.encode("utf-8")


SCHEMA_JS = r"""
const {DatabaseSync}=require('node:sqlite'),crypto=require('node:crypto');
const db=new DatabaseSync('/data/crm.sqlite',{readOnly:true});
const cols=name=>db.prepare('PRAGMA table_info("'+name+'")').all().map(x=>x.name);
const channelExpected=['company_code','id','name','target','enabled','encrypted_token','revision','checked_revision','status','checked_at','updated_at','provider','profile_display_name','destination_revision'];
const channels=cols('autoposting_channels'),posts=cols('autoposting_posts'),companies=cols('companies');
if(JSON.stringify([...channels].sort())!==JSON.stringify([...channelExpected].sort()))throw Error('CHANNEL_SCHEMA');
if(!['id','code','is_deleted'].every(k=>companies.includes(k))||!['company_id','status','scheduled_at'].every(k=>posts.includes(k)))throw Error('POST_SCHEMA');
const owner=db.prepare('SELECT id FROM companies WHERE code=? COLLATE NOCASE AND is_deleted=0').get('palitra-love');
if(!owner)throw Error('COMPANY_SCOPE');
const schemas=db.prepare("SELECT name,sql FROM sqlite_schema WHERE type IN ('table','index','trigger') AND (name LIKE 'autoposting_%' OR name LIKE 'publication_%') ORDER BY name").all();
const schemaSha=crypto.createHash('sha256').update(JSON.stringify(schemas)).digest('hex');
const safeChannels=db.prepare('SELECT id,provider,target,enabled,revision,checked_revision,status FROM autoposting_channels WHERE company_code=? COLLATE NOCASE ORDER BY id').all('palitra-love');
const statuses=db.prepare('SELECT status,count(*) count FROM autoposting_posts WHERE company_id=? GROUP BY status ORDER BY status').all(owner.id);
console.log(JSON.stringify({channelColumns:channels,postColumns:posts,schemaObjectCount:schemas.length,schemaSha256:schemaSha,channels:safeChannels,statuses}));
db.close();
"""


def inspect(spec):
    require(os.geteuid() == 0, "ROOT_REQUIRED")
    require(pathlib.Path.cwd().resolve() == pathlib.Path("/opt/synapse"), "HOST_CONTEXT")
    identity = run("IDENTITY", ["docker", "inspect", CONTAINER, "--format",
                   "{{.Id}}|{{.Image}}|{{.State.StartedAt}}|{{.RestartCount}}"])
    fields = identity.decode().strip().split("|")
    require(len(fields) == 4 and fields[1].startswith(IMAGE_PREFIX) and
            re.fullmatch(r"sha256:[a-f0-9]{64}", fields[1]), "RUNTIME_CONTEXT")
    mounts = run("MOUNTS", ["docker", "inspect", CONTAINER, "--format",
                 "{{range .Mounts}}{{.Type}}|{{.Destination}}|{{.RW}}{{println}}{{end}}"]).decode().splitlines()
    require([x for x in mounts if x] == ["volume|/data|true"], "MOUNT_CHANGED")
    changes = run("DIFF", ["docker", "diff", CONTAINER]).decode().splitlines()
    app_changes = [line for line in changes if line[2:].startswith("/app")]
    compose = run("COMPOSE_PATH", ["docker", "inspect", CONTAINER, "--format",
                  '{{index .Config.Labels "com.docker.compose.project.config_files"}}']).decode().strip()
    compose_paths = compose.split(",")
    # Read-only discovery: the actual label includes historical /opt/palitra-*
    # overlays. Do not execute Compose here or infer installation permission.
    require(bool(compose) and all(
        p.startswith(("/opt/synapse/", "/opt/palitra-")) and
        ".." not in pathlib.PurePosixPath(p).parts and "\n" not in p
        for p in compose_paths), "COMPOSE_CONTEXT")
    print("RUNTIME_DISCOVERY", json.dumps({"containerId": fields[0],
          "imageGroups": " ".join(fields[1][7:][i:i+8] for i in range(0,64,8)),
          "startedAt": fields[2], "restartCount": fields[3],
          "appChanges": app_changes, "composeFileCount": len(compose_paths),
          "composeLabelSha256": digest(compose.encode())}, separators=(",", ":")), flush=True)
    source = run("CORE_SOURCE", ["docker", "exec", CONTAINER, "cat", "/app/autoposting.js"])
    provider = run("PROVIDER_SOURCE", ["docker", "exec", CONTAINER, "cat", "/app/onlypult-provider.js"])
    transport = run("TRANSPORT_SOURCE", ["docker", "exec", CONTAINER, "cat", "/app/autoposting-transport.js"])
    require(digest(provider) == PROVIDER_BEFORE and digest(transport) == TRANSPORT, "ADAPTER_CHANGED")
    # In-memory planning, never installation acceptance. The full observed identity
    # must be independently frozen in the later release guard before any write.
    observed_spec = dict(spec, actualRuntimeBeforeSha256=digest(source))
    require(digest(source).startswith("caf1675a"), "CORE_CONTEXT_CHANGED")
    candidate = rebase(source, observed_spec)
    print("SOURCE_DISCOVERY", json.dumps({"beforeGroups": " ".join(digest(source)[i:i+8] for i in range(0,64,8)),
          "afterGroups": " ".join(digest(candidate)[i:i+8] for i in range(0,64,8)),
          "bytesBefore": len(source), "bytesAfter": len(candidate),
          "reverseExact": True, "groups": len(spec["patches"])}, separators=(",", ":")), flush=True)
    run("CANDIDATE_SYNTAX", ["docker", "exec", "-i", CONTAINER, "node", "--check"], candidate)
    schema = json.loads(run("SCHEMA_READONLY", ["docker", "exec", "-i", CONTAINER, "node", "-"], SCHEMA_JS.encode()))
    locks = json.loads(run("LOCKS", ["lslocks", "-J", "-o", "PID,COMMAND,PATH"]))
    relevant = [r for r in locks.get("locks", []) if "/opt/synapse/" in (r.get("path") or "")]
    lock_path = pathlib.Path("/opt/synapse/.palitra-app-release.lock")
    info = lock_path.lstat()
    require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and info.st_nlink == 1, "LOCK_FILE_UNSAFE")
    print("RUNTIME_META", json.dumps({"uid": os.geteuid(), "container": fields,
          "mounts": mounts, "appChanges": app_changes,
          "composeFileCount": len(compose_paths), "composeLabelSha256": digest(compose.encode()),
          "resourceLocks": relevant}, separators=(",", ":")))
    print("SOURCE_REBASE", json.dumps({"before": digest(source), "after": digest(candidate),
          "beforeGroups": " ".join(digest(source)[i:i+8] for i in range(0,64,8)),
          "imageGroups": " ".join(fields[1][7:][i:i+8] for i in range(0,64,8)),
          "bytesBefore": len(source), "bytesAfter": len(candidate), "groups": len(spec["patches"]),
          "reverseExact": True, "syntax": "PASS", "publishedCopyPreserved": b"function createPublishedCopy" in candidate}, separators=(",", ":")))
    print("SCHEMA_READONLY", json.dumps(schema, separators=(",", ":")))
    print("READ_ONLY_INSPECTION_PASS; writes=0; lease=0; backup=0; restart=0; send=0")


PATCH_SPEC = {'featureCommit': '2e6152082d9f52e2f0fc3f03f48d2395d0d23550', 'featureBaseSha256': '038072ce7670f015d64f0223b634f2ad185cc6d5c19d60c5b16c2bf0cfe383af', 'featureAfterSha256': '251a933eae2674cab26159ae454c33f9f3682333c1a1fd9f18a6c990fe2807a7', 'runtimeSourcePrefixForReadonlyDiscovery': 'caf1675a', 'patches': [{'before': "const FORMATS=Object.freeze({post:'Пост',story:'Сторис',reel:'Reels / Shorts / клип',carousel:'Карусель'});\nconst ROLES=Object.freeze({reach:'Охватный',affection:'На влюбление',sale:'На продажу'});\nconst REVIEW_STATES=Object.freeze({draft:'Черновик',pending:'На согласовании',approved:'Согласовано',rejected:'Отклонено'});\nconst META_LIMITS=Object.freeze({audience:500,hook:500,idea:4000,hughNote:2000,metrics:1000,methodSource:300});\nfunction meta(value) {\n  if(value===null||value===undefined)return {};\n", 'after': "const FORMATS=Object.freeze({post:'Пост',story:'Сторис',reel:'Reels / Shorts / клип',carousel:'Карусель'});\nconst ROLES=Object.freeze({reach:'Охватный',affection:'На влюбление',sale:'На продажу'});\nconst REVIEW_STATES=Object.freeze({draft:'Черновик',pending:'На согласовании',approved:'Согласовано',rejected:'Отклонено'});\nconst DELIVERY_BLOCKER_MESSAGES=Object.freeze({\n  TIKTOK_PRIVACY_UNCONFIRMED:'Для отправки в TikTok сервис должен подтвердить доступную аудиторию профиля. Текущий контракт Onlypult этих данных не возвращает.',\n});\nfunction deliveryBlocker(channel){\n  const code=channel?.caps?.deliveryBlocker;\n  if(!code)return null;\n  return Object.hasOwn(DELIVERY_BLOCKER_MESSAGES,code)\n    ?{code,message:DELIVERY_BLOCKER_MESSAGES[code]}\n    :{code:'CHANNEL_DELIVERY_BLOCKED',message:'Возможность отправки на выбранную площадку не подтверждена.'};\n}\nconst META_LIMITS=Object.freeze({audience:500,hook:500,idea:4000,hughNote:2000,metrics:1000,methodSource:300});\nfunction meta(value) {\n  if(value===null||value===undefined)return {};\n"}, {'before': "   Состав полей взят из проверенной OpenAPI Onlypult (29.09.2026), ничего сверх неё не принимается.\n   Опции одной площадки не отправляются другой.\n   instagram: is_story и is_reels взаимоисключающие — Story и Reel это разные режимы.\n   tiktok.privacy: полного перечня доступных конкретному аккаунту режимов схема не даёт,\n   поэтому принимаются только два документированных значения, и «по умолчанию публично»\n   здесь не подставляется — без явного выбора отправка TikTok не идёт. */\nconst PLATFORM_OPTION_SCHEMA=Object.freeze({\n  instagram:Object.freeze({is_story:'boolean',is_reels:'boolean',disable_comment:'boolean'}),\n  tiktok:Object.freeze({privacy:['PUBLIC_TO_EVERYONE','SELF_ONLY'],disable_comment:'boolean',disable_duet:'boolean',disable_stitch:'boolean'}),\n  max:Object.freeze({pin_message:'boolean'}),\n});\nfunction platformOptions(value) {\n", 'after': "   Состав полей взят из проверенной OpenAPI Onlypult (29.09.2026), ничего сверх неё не принимается.\n   Опции одной площадки не отправляются другой.\n   instagram: is_story и is_reels взаимоисключающие — Story и Reel это разные режимы.\n   tiktok.privacy: четыре значения контракта Onlypult (официальный SDK 0.1.9),\n   не перечень возможностей автора. «По умолчанию публично» не подставляется;\n   Onlypult должен принять точный согласованный режим без замены и повторного POST. */\nconst PLATFORM_OPTION_SCHEMA=Object.freeze({\n  instagram:Object.freeze({is_story:'boolean',is_reels:'boolean',disable_comment:'boolean'}),\n  tiktok:Object.freeze({privacy:['PUBLIC_TO_EVERYONE','MUTUAL_FOLLOW_FRIENDS','FOLLOWER_OF_CREATOR','SELF_ONLY'],disable_comment:'boolean',disable_duet:'boolean',disable_stitch:'boolean'}),\n  max:Object.freeze({pin_message:'boolean'}),\n});\nfunction platformOptions(value) {\n"}, {'before': "    const mediaOnlyStory=mediaOnlyStoryRow(row,media,caps);\n    if(!row.text&&!Object.keys(caps).length&&!mediaOnlyStory)issues.push('Нет текста и подписей площадок');\n    for(const [platform,caption]of Object.entries(caps))if(caption.length>CAPTION_PLATFORMS[platform].limit)issues.push(`Подпись ${CAPTION_PLATFORMS[platform].label} длиннее лимита`);\n    return {ready:!issues.length,issues,mediaKind:mediaKind(media),textOnly,mediaOnlyStory};\n  }\n  /* Одобрение привязано к content_revision — версии содержимого (текст, подписи, материал, день, происхождение).\n", 'after': "    const mediaOnlyStory=mediaOnlyStoryRow(row,media,caps);\n    if(!row.text&&!Object.keys(caps).length&&!mediaOnlyStory)issues.push('Нет текста и подписей площадок');\n    for(const [platform,caption]of Object.entries(caps))if(caption.length>CAPTION_PLATFORMS[platform].limit)issues.push(`Подпись ${CAPTION_PLATFORMS[platform].label} длиннее лимита`);\n    if(ids.includes('tiktok')){\n      const options=JSON.parse(row.platform_options||'{}').tiktok||{};\n      if(!PLATFORM_OPTION_SCHEMA.tiktok.privacy.includes(options.privacy))issues.push('Выберите, кто увидит видео TikTok');\n      if(media.length!==1||!isShortsVideoUrl(media[0]))issues.push('Для TikTok нужно одно видео');\n    }\n    return {ready:!issues.length,issues,mediaKind:mediaKind(media),textOnly,mediaOnlyStory};\n  }\n  /* Одобрение привязано к content_revision — версии содержимого (текст, подписи, материал, день, происхождение).\n"}, {'before': "  function capsIssues(channel,caption,mediaCount) {\n    const caps=channel&&typeof channel.caps==='object'&&channel.caps?channel.caps:null,issues=[];\n    if(!caps)return issues;\n    if(Number.isFinite(caps.maxText)&&caption.length>caps.maxText)issues.push(`Текст длиннее лимита площадки (${caps.maxText})`);\n    if(Number.isFinite(caps.maxMedia)&&mediaCount>caps.maxMedia)issues.push(`Материалов больше, чем принимает площадка (${caps.maxMedia})`);\n    if(Number.isFinite(caps.maxCaption)&&mediaCount&&caption.length>caps.maxCaption)issues.push(`Подпись к материалу длиннее лимита площадки (${caps.maxCaption})`);\n", 'after': "  function capsIssues(channel,caption,mediaCount) {\n    const caps=channel&&typeof channel.caps==='object'&&channel.caps?channel.caps:null,issues=[];\n    if(!caps)return issues;\n    const blocker=deliveryBlocker(channel);if(blocker)issues.push(blocker.message);\n    if(Number.isFinite(caps.maxText)&&caption.length>caps.maxText)issues.push(`Текст длиннее лимита площадки (${caps.maxText})`);\n    if(Number.isFinite(caps.maxMedia)&&mediaCount>caps.maxMedia)issues.push(`Материалов больше, чем принимает площадка (${caps.maxMedia})`);\n    if(Number.isFinite(caps.maxCaption)&&mediaCount&&caption.length>caps.maxCaption)issues.push(`Подпись к материалу длиннее лимита площадки (${caps.maxCaption})`);\n"}, {'before': "      const marked=receiptPlatforms(row.id);\n      const blocked=data.platformIds.filter((id,index)=>marked.has(channelPlatform(channels[index],id)));\n      if(blocked.length)fail(409,`Уже отмечено как опубликованное вне ЛК: ${blocked.join(', ')}. Повторная отправка создаст дубликат.`,'EXTERNAL_PUBLICATION_RECORDED');\n      if(channels.some(channel=>!channel||!channel.enabled||!channel.connected))fail(409,'Выбранный канал не подключён','CHANNEL_NOT_CONNECTED');\n      if(companyApprovalRequired(row)&&!data.mediaUrls.length){\n        if(!readiness(row).textOnly||channels.some(channel=>(channel.provider||'direct')!=='direct'||!['telegram','vk'].includes(channel.platform||channel.id)))\n          fail(409,'Для этого способа публикации нужен материал: текст без медиа поддержан только прямыми Telegram и ВКонтакте','NOT_READY');\n", 'after': "      const marked=receiptPlatforms(row.id);\n      const blocked=data.platformIds.filter((id,index)=>marked.has(channelPlatform(channels[index],id)));\n      if(blocked.length)fail(409,`Уже отмечено как опубликованное вне ЛК: ${blocked.join(', ')}. Повторная отправка создаст дубликат.`,'EXTERNAL_PUBLICATION_RECORDED');\n      if(channels.some(channel=>!channel||!channel.connected))fail(409,'Выбранный канал не подключён','CHANNEL_NOT_CONNECTED');\n      if(channels.some(channel=>!channel.enabled))fail(409,'Отправка на выбранную площадку выключена','CHANNEL_DISABLED');\n      // Не создавать частичную доставку на остальные каналы при заведомом отказе одного.\n      // Одобрение содержимого допустимо отдельно; approveAndSchedule откатится атомарно.\n      const deliveryBlocked=channels.map(deliveryBlocker).find(Boolean);\n      if(deliveryBlocked)fail(409,deliveryBlocked.message,deliveryBlocked.code);\n      if(companyApprovalRequired(row)&&!data.mediaUrls.length){\n        if(!readiness(row).textOnly||channels.some(channel=>(channel.provider||'direct')!=='direct'||!['telegram','vk'].includes(channel.platform||channel.id)))\n          fail(409,'Для этого способа публикации нужен материал: текст без медиа поддержан только прямыми Telegram и ВКонтакте','NOT_READY');\n"}, {'before': '      for(const delivery of conflicting)cancel.run(due.id,delivery.channel_id);\n      review(due.id,\'EXTERNAL_PUBLICATION_RECORDED\');return;\n    }\n    const lease=randomUUID();\n    const claimed=db.prepare("UPDATE autoposting_posts SET status=\'publishing\',publishing_at=?,lease=?,revision=revision+1,updated_at=? WHERE id=? AND status=\'scheduled\' AND revision=? AND deleted_at IS NULL AND archived_at IS NULL")\n      .run(now(),lease,iso(),due.id,due.revision);\n', 'after': '      for(const delivery of conflicting)cancel.run(due.id,delivery.channel_id);\n      review(due.id,\'EXTERNAL_PUBLICATION_RECORDED\');return;\n    }\n    // Применяется и к старой очереди: известный отказ одного ещё не отправленного,\n    // согласованного канала останавливает группу до первого POST. Результаты уже\n    // выполненных доставок и сохранённые pending-записи остаются нетронутыми.\n    const deliveryBlocked=deliveries.filter(item=>item.status===\'pending\'&&deliveryApproved(due,item.channel_id))\n      .map(item=>deliveryBlocker(settings.channels.find(channel=>channel.id===item.channel_id))).find(Boolean);\n    if(deliveryBlocked){review(due.id,deliveryBlocked.code);return;}\n    // Старые согласованные записи без явной аудитории также не дают частичной отправки.\n    if(deliveries.some(item=>item.status===\'pending\'&&item.channel_id===\'tiktok\'&&deliveryApproved(due,item.channel_id))&&!readiness(due).ready){review(due.id,\'NOT_READY\');return;}\n    const lease=randomUUID();\n    const claimed=db.prepare("UPDATE autoposting_posts SET status=\'publishing\',publishing_at=?,lease=?,revision=revision+1,updated_at=? WHERE id=? AND status=\'scheduled\' AND revision=? AND deleted_at IS NULL AND archived_at IS NULL")\n      .run(now(),lease,iso(),due.id,due.revision);\n'}], 'preserve': 'All current published-copy/plan-link/fingerprint changes remain outside these hunks; reverse patch must yield exact actualRuntimeBeforeSha256'}

if __name__ == "__main__":
    try:
        inspect(PATCH_SPEC)
    except Refused as error:
        print("READ_ONLY_INSPECTION_REFUSED", str(error))
        raise SystemExit(1)
    except Exception as error:
        print("READ_ONLY_INSPECTION_REFUSED", type(error).__name__)
        raise SystemExit(1)
