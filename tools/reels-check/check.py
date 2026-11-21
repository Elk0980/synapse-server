#!/usr/bin/env python3
"""Автопроверка ролика по правилам tools/reels-check/RULES.md.

Пример:
    python3 check.py clip.mp4 --profile site-loop --mechanic M1
    python3 check.py reel.mp4 --profile reel --project avokado --subs reel.ass --json

Зависимости: Python 3.9+, numpy, ffmpeg и ffprobe в PATH.
Код выхода: 0 — нет ✘; 1 — есть хотя бы один ✘; 2 — ошибка запуска.
"""
import argparse
import json
import math
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

try:
    import numpy as np
except ImportError:  # pragma: no cover - печатается пользователю
    print('reels-check: нужен numpy (pip install numpy)', file=sys.stderr)
    sys.exit(2)

OK, FAIL, WARN, SKIP = 'ok', 'fail', 'warn', 'skip'
MARK = {OK: '✔', FAIL: '✘', WARN: '⚠', SKIP: '—'}

PROFILES = ('reel', 'site-loop', 'site-scrub')
MECHANICS = ('M1', 'M2', 'M3', 'M4', 'M5')
DEFAULT_MECHANIC = {'site-loop': 'M1', 'site-scrub': 'M3', 'reel': None}

KB = 1024
# R11: лимиты веса по механике (MEHANIKI_DVIZHENIYA 29.08.2026)
WEIGHT_LIMIT = {'M1': 600 * KB, 'M2': 300 * KB, 'M3': int(1.5 * 1024 * KB), 'M4': 1024 * KB}
MOBILE_BLOCK_LIMIT = 350 * KB  # VIDEO_PREFLIGHT, блочный ролик на телефоне

# R16: звук рилса по проекту. 'voice' — голос согласован; 'none' — без звука в файле.
PROJECT_AUDIO = {'avokado': 'voice', 'alvi': 'none', 'palitra': 'none', 'synapse': 'none'}

SEAM_OK, SEAM_WARN = 3.0, 8.0  # R07
# R06: отношение «зеркальная разница / движение от точки разворота».
# Перекодированный палиндром даёт около 0.06; прямые синтетические ролики — от 0.38.
REVERSE_FAIL, REVERSE_WARN = 0.2, 0.3
LUFS_TARGET, LUFS_TOL = -15.0, 1.5  # R18
SUB_MAX_CHARS = 17  # R19
HANGING_WORDS = {
    'и', 'а', 'о', 'в', 'к', 'с', 'у', 'я', 'не', 'на', 'по', 'за', 'из', 'от', 'до',
    'но', 'во', 'со', 'ко', 'об', 'ни', 'же', 'ли', 'бы',
}
TITLE_STYLE = re.compile(r'title|titr|титр|\btop\b|head|верх', re.I)

# Ручные правила: что показать человеку или модели в отчёте.
MANUAL = {
    'reel': [
        ('R20', 'титры и наложения не перекрывают лицо и фигуру; под титры спокойная зона'),
        ('R21', 'персонаж цел и совпадает с листом ракурсов (первый, средний, последний кадр)'),
        ('R22', 'на экране телефона нет пальца'),
        ('R23', 'запись сайта вписана в маску экрана телефона; отрывки — из списка Влада'),
        ('R24', 'в мокапах живое видео сайта, не логотип и не скриншот'),
        ('R27', 'нет кнопок паузы, стрелок, счётчика, курсора, служебных кнопок'),
        ('R28', 'нет личных данных: дети, адреса, телефоны, переписка, чеки, имена на декоре'),
        ('R29', 'цена — только подтверждённая клиентом на дату выхода'),
        ('R30', 'пробный ролик помечен как несогласованный черновик'),
        ('R17', 'музыка не вшита: трек ставится при публикации (послушать)'),
    ],
    'site-loop': [
        ('R20', 'наложения кода не перекрывают лицо и фигуру; спокойная зона под текст'),
        ('R21', 'персонаж цел на первом, среднем и последнем кадре'),
        ('R08', 'петля замкнута по минимальной разнице кадров, без кроссфейда хвост-в-голову'),
        ('R14', 'на странице autoplay muted playsinline и постер'),
        ('R15', 'на странице не больше трёх живых блоков'),
        ('R28', 'нет личных данных в кадре'),
    ],
    'site-scrub': [
        ('R21', 'персонаж цел на первом, среднем и последнем кадре'),
        ('R10', 'склейки обоснованы в отчёте; стык от кадра к кадру'),
        ('R15', 'на телефоне ролик отключён'),
        ('R28', 'нет личных данных в кадре'),
    ],
}


class CheckError(Exception):
    pass


def run(cmd, binary=False):
    proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if proc.returncode != 0:
        raise CheckError('Команда завершилась с ошибкой: ' + ' '.join(cmd[:3]) + ' … ' +
                         proc.stderr.decode('utf-8', 'replace')[-400:])
    return proc.stdout if binary else proc.stdout.decode('utf-8', 'replace')


def require_tools():
    for tool in ('ffmpeg', 'ffprobe'):
        if not shutil.which(tool):
            raise CheckError(tool + ' не найден в PATH — установите ffmpeg (см. README)')


def parse_rate(text):
    if not text or text in ('0/0', 'N/A'):
        return 0.0
    if '/' in text:
        num, den = text.split('/', 1)
        return float(num) / float(den) if float(den) else 0.0
    return float(text)


URL_LIKE = re.compile(r'^[A-Za-z][A-Za-z0-9+.-]+:')  # concat:, http:, pipe: …; буква диска C: не попадает


def local_input(path):
    """Только локальный файл: протоколы ffmpeg (concat:, http:// и т. п.) отклоняются."""
    text = str(path)
    if URL_LIKE.match(text):
        raise CheckError('Нужен локальный файл, а не адрес или протокол ffmpeg: ' + text)
    p = Path(text)
    if not p.is_file():
        raise CheckError('Файл не найден: ' + text)
    return 'file:' + str(p.resolve())


def local_output(path):
    return 'file:' + str(Path(path).resolve())


def probe(path):
    data = json.loads(run(['ffprobe', '-v', 'error', '-print_format', 'json',
                           '-show_format', '-show_streams', local_input(path)]))
    video = next((s for s in data.get('streams', []) if s.get('codec_type') == 'video'), None)
    if video is None:
        raise CheckError('В файле нет видеодорожки: ' + str(path))
    audio = [s for s in data.get('streams', []) if s.get('codec_type') == 'audio']
    width, height = int(video['width']), int(video['height'])
    rotation = 0
    for side in video.get('side_data_list', []) or []:
        if 'rotation' in side:
            rotation = int(float(side['rotation']))
    if 'rotate' in (video.get('tags') or {}):
        rotation = int(video['tags']['rotate'])
    if abs(rotation) % 180 == 90:
        width, height = height, width
    fps = parse_rate(video.get('avg_frame_rate')) or parse_rate(video.get('r_frame_rate'))
    duration = float(video.get('duration') or data.get('format', {}).get('duration') or 0)
    return {
        'width': width, 'height': height, 'fps': fps, 'duration': duration,
        'codec': video.get('codec_name', ''), 'format': data.get('format', {}).get('format_name', ''),
        'size': int(data.get('format', {}).get('size') or os.path.getsize(path)),
        'audio': audio,
    }


def decode_gray(path, info, width=160):
    height = max(2, int(round(width * info['height'] / info['width'] / 2.0)) * 2)
    raw = run(['ffmpeg', '-v', 'error', '-i', local_input(path), '-map', '0:v:0', '-vf',
               f'scale={width}:{height}:flags=area,format=gray', '-f', 'rawvideo', '-'], binary=True)
    frame = width * height
    count = len(raw) // frame
    if count < 2:
        raise CheckError('Слишком мало кадров для анализа')
    return np.frombuffer(raw[:count * frame], dtype=np.uint8).reshape(count, height, width)


def rms(a, b):
    d = a.astype(np.float32) - b.astype(np.float32)
    return float(np.sqrt(np.mean(d * d)))


def fmt_t(seconds):
    return f'{seconds:.2f} с'


def result(rule, status, detail, at=''):
    return {'rule': rule, 'status': status, 'detail': detail, 'at': at}


# ---------- формат и качество ----------

def check_resolution(info, profile):
    w, h = info['width'], info['height']
    if profile == 'reel':
        if h <= w:
            return result('R01', FAIL, f'{w}×{h}: не вертикаль 9:16')
        if abs(w / h - 9 / 16) > 0.01:
            return result('R01', FAIL, f'{w}×{h}: пропорция не 9:16')
        if w < 1080:
            return result('R01', FAIL, f'{w}×{h}: меньше 1080×1920')
        return result('R01', OK, f'{w}×{h}')
    short = min(w, h)
    if short >= 1080:
        return result('R02', OK, f'{w}×{h}')
    return result('R02', WARN, f'{w}×{h}: меньше 1080p — допустимо для веб-копии, мастер должен быть 1080p')


def check_fps(info):
    fps = info['fps']
    if 23.9 <= fps <= 30.01:
        return result('R03', OK, f'{fps:.3g} к/с')
    if fps > 30.01:
        return result('R03', FAIL, f'{fps:.3g} к/с: больше 30 — стандарт 24–30')
    return result('R03', FAIL, f'{fps:.3g} к/с: меньше 24')


def check_source(info, source_info):
    if source_info is None:
        return [result('R04', SKIP, 'исходник не передан (--source)'),
                result('R05', SKIP, 'исходник не передан (--source)')]
    out = []
    sw, sh = source_info['width'], source_info['height']
    w, h = info['width'], info['height']
    if sw > sh and h > w:
        out.append(result('R04', FAIL, f'исходник горизонтальный {sw}×{sh}, результат вертикальный {w}×{h}: вертикаль кропом'))
    else:
        out.append(result('R04', OK, f'ориентация исходника {sw}×{sh} совпадает'))
    factor = max(w / sw, h / sh)
    if factor <= 1.0:
        out.append(result('R05', OK, f'без увеличения (×{factor:.2f})'))
    elif factor <= 1.5:
        out.append(result('R05', OK, f'увеличение ×{factor:.2f} ≤ 1,5; метод Lanczos подтвердить по журналу'))
    else:
        out.append(result('R05', FAIL, f'увеличение ×{factor:.2f} > 1,5'))
    return out


# ---------- петли, реверс, события ----------

def check_seam(frames, fps):
    seam = rms(frames[-1], frames[0])
    diffs = [rms(frames[i], frames[i + 1]) for i in range(len(frames) - 1)]
    bg = float(np.median(diffs)) if diffs else 0.0
    detail = f'RMS шва {seam:.2f} (фон соседних кадров {bg:.2f})'
    at = f'последний кадр {fmt_t((len(frames) - 1) / fps)} → первый'
    if seam <= SEAM_OK:
        return result('R07', OK, detail, at)
    if seam <= SEAM_WARN:
        return result('R07', WARN, detail + ': заметно на большом экране, только небольшой блок с оговоркой', at)
    return result('R07', FAIL, detail + (': шов виден явно' if seam >= 30 else ': больше 8'), at)


def find_reverse(frames, fps):
    """Ищет точку разворота: кадры c-d и c+d (или c+1+d) совпадают, хотя кадр движется."""
    step = max(1, int(round(frames.shape[2] / 64)))
    small = frames[:, ::step, ::step].astype(np.float32)
    n = len(small)
    w_min = max(3, int(round(fps * 0.5)))
    w_max = max(w_min, int(round(fps * 1.0)))
    best = None
    for c in range(w_min, n - w_min):
        for odd in (0, 1):
            b = c + odd
            span = min(w_max, c, n - 1 - b)
            if span < w_min:
                continue
            ds = range(1, span + 1, max(1, span // 8))
            mirror = np.mean([np.sqrt(np.mean((small[c - d] - small[b + d]) ** 2)) for d in ds])
            base = np.mean([np.sqrt(np.mean((small[b + d] - small[b]) ** 2)) for d in ds])
            if base < 1.5:
                continue  # почти статичный кадр: разворот не виден
            score = mirror / base
            if best is None or score < best[0]:
                best = (score, c, mirror, base)
    return best


def check_reverse(frames, fps):
    best = find_reverse(frames, fps)
    if best is None:
        return result('R06', SKIP, 'движения для разворота нет (кадр почти статичен) — реверс не оценивался')
    score, c, mirror, base = best
    at = f'разворот около {fmt_t(c / fps)} (кадр {c})'
    detail = f'зеркальная разница {mirror:.2f} при движении {base:.2f} (отношение {score:.2f})'
    if score < REVERSE_FAIL:
        return result('R06', FAIL, 'реверс/пинг-понг: ' + detail +
                      '; если это естественное качание — показать человеку', at)
    if score < REVERSE_WARN:
        return result('R06', WARN, 'похоже на реверс: ' + detail + '; посмотреть глазами', at)
    return result('R06', OK, 'реверса не найдено (минимальное отношение %.2f)' % score)


def event_pairs(frames):
    p = []
    for i in range(len(frames) - 1):
        d = np.abs(frames[i + 1].astype(np.int16) - frames[i].astype(np.int16))
        p.append(float(np.percentile(d, 99.7)))
    return np.array(p)


def find_events(frames, fps):
    p = event_pairs(frames)
    bg = float(np.median(p))
    thr = 2.0 * max(bg, 2.0)  # пол 2.0 отсекает шум кодека в статичных кадрах
    hot = np.nonzero(p > thr)[0]
    events, gap = [], max(1, int(round(fps * 0.25)))
    for i in hot:
        if events and i - events[-1][1] <= gap:
            events[-1][1] = int(i)
        else:
            events.append([int(i), int(i)])
    return events, bg, thr, p


def check_events(frames, fps, mechanic):
    if mechanic is None:
        return result('R09', SKIP, 'механика не задана (--mechanic)')
    events, bg, thr, _ = find_events(frames, fps)
    times = ', '.join(f'{fmt_t(a / fps)}–{fmt_t((b + 1) / fps)}' for a, b in events)
    detail = f'событий: {len(events)} (фон {bg:.1f}, порог {thr:.1f})'
    if mechanic in ('M1', 'M4'):
        status = OK if not events else FAIL
        return result('R09', status, detail + ('' if not events else '; для ' + mechanic + ' должно быть 0'), times)
    if mechanic == 'M2':
        if len(events) != 1:
            return result('R09', FAIL, detail + '; для M2 должно быть ровно одно', times)
        if events[0][1] >= len(frames) - 2:
            return result('R09', FAIL, detail + '; событие не завершено к последнему кадру', times)
        return result('R09', OK, detail, times)
    return result('R09', WARN if events else OK,
                  detail + ('; M3: повторы событий сверить глазами' if events else ''), times)


def check_loop_length(info):
    if info['duration'] < 3.0:
        return result('R08', FAIL, f'длина петли {info["duration"]:.2f} с < 3 с')
    return result('R08', OK, f'длина петли {info["duration"]:.2f} с ≥ 3 с; способ замыкания — по журналу')


# ---------- вес, кодек, отдача ----------

def check_weight(info, mechanic, mobile):
    size = info['size']
    if mechanic not in WEIGHT_LIMIT:
        return result('R11', SKIP, f'{size / KB:.0f} КБ; для механики {mechanic} лимита нет')
    limit = WEIGHT_LIMIT[mechanic]
    label = mechanic
    if mobile and mechanic == 'M1':
        limit, label = MOBILE_BLOCK_LIMIT, 'M1, телефон'
    detail = f'{size / KB:.0f} КБ при лимите {limit / KB:.0f} КБ ({label})'
    return result('R11', OK if size <= limit else FAIL, detail)


def check_codec(path, info, mechanic):
    codec, fmt = info['codec'], info['format']
    if mechanic in ('M2', 'M3'):
        if codec == 'h264' and 'mp4' in fmt:
            return [result('R12', OK, f'{codec} в mp4')]
        return [result('R12', FAIL, f'{codec} ({fmt}): для {mechanic} нужен H.264 в mp4')]
    out = []
    if codec in ('vp9', 'h264'):
        out.append(result('R12', OK, f'кодек {codec}'))
    else:
        out.append(result('R12', FAIL, f'кодек {codec}: нужен webm VP9 или mp4 H.264'))
    pair_ext = '.mp4' if Path(path).suffix.lower() == '.webm' else '.webm'
    pair = Path(path).with_suffix(pair_ext)
    if pair.exists():
        out.append(result('R12', OK, f'пара найдена: {pair.name}'))
    else:
        out.append(result('R12', WARN, f'нет пары {pair.name} (webm VP9 + mp4 H.264)'))
    return out


def check_keyframes(path, info):
    flags = run(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries',
                 'packet=flags', '-of', 'csv=p=0', local_input(path)]).split()
    keys = [i for i, f in enumerate(flags) if 'K' in f]
    if not keys:
        return result('R13', FAIL, 'ключевых кадров не найдено')
    gaps = [b - a for a, b in zip(keys, keys[1:])] + [len(flags) - keys[-1]]
    worst = max(gaps)
    detail = f'ключевых кадров {len(keys)} на {len(flags)}; самый длинный промежуток {worst}'
    at = f'ключевые кадры: {keys[:12]}{"…" if len(keys) > 12 else ""}'
    return result('R13', OK if worst <= 15 else FAIL, detail + ('' if worst <= 15 else ' > 15'), at)


def check_site_audio(path, info):
    out = []
    if info['audio']:
        out.append(result('R14', FAIL, 'есть звуковая дорожка: видео для сайта без звука'))
    else:
        out.append(result('R14', OK, 'звуковой дорожки нет'))
    stem = Path(path).with_suffix('')
    posters = [p for ext in ('.jpg', '.jpeg', '.webp', '.png')
               for p in (Path(str(stem) + ext), Path(str(stem) + '-poster' + ext)) if p.exists()]
    if posters:
        out.append(result('R14', OK, 'постер найден: ' + posters[0].name))
    else:
        out.append(result('R14', WARN, 'постер рядом не найден (имя ролика + .jpg/.webp/.png)'))
    return out


# ---------- звук и титры рилса ----------

def loudness(path):
    proc = subprocess.run(['ffmpeg', '-hide_banner', '-nostats', '-i', local_input(path), '-map', '0:a:0',
                           '-af', 'ebur128', '-f', 'null', '-'], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    text = proc.stderr.decode('utf-8', 'replace')
    found = re.findall(r'I:\s+(-?[\d.]+|-inf)\s+LUFS', text)
    if not found:
        return None
    value = found[-1]
    return -math.inf if value == '-inf' else float(value)


def check_reel_audio(path, info, project):
    if project is None:
        return [result('R16', SKIP, 'проект не задан (--project): политика звука неизвестна')]
    policy = PROJECT_AUDIO.get(project)
    if policy is None:
        return [result('R16', SKIP, f'для проекта {project} политика звука не записана в RULES.md')]
    if not info['audio']:
        if policy == 'none':
            return [result('R16', OK, f'{project}: без звука, дорожки нет')]
        return [result('R16', FAIL, f'{project}: нужен голос, а звуковой дорожки нет')]
    level = loudness(path)
    silent = level is None or level < -60
    if policy == 'none':
        if silent:
            return [result('R16', WARN, f'{project}: дорожка есть, но тихая — удалить дорожку')]
        return [result('R16', FAIL, f'{project}: в файле есть звук ({level:.1f} LUFS), а проект без звука; '
                       'музыку ставят при публикации'), result('R17', FAIL, 'звук вшит в файл проекта без звука')]
    if silent:
        return [result('R16', WARN, f'{project}: дорожка тихая'), result('R18', FAIL, 'громкость не измерена')]
    status = OK if abs(level - LUFS_TARGET) <= LUFS_TOL else WARN
    return [result('R16', OK, f'{project}: голос согласован, дорожка есть'),
            result('R18', status, f'{level:.1f} LUFS (цель {LUFS_TARGET:.0f} ±{LUFS_TOL})')]


def parse_subs(path):
    text = Path(path).read_text(encoding='utf-8-sig', errors='replace')
    events = []
    if Path(path).suffix.lower() == '.ass' or '[Events]' in text:
        fields = None
        for line in text.splitlines():
            if line.startswith('Format:') and fields is None and 'Text' in line:
                fields = [f.strip() for f in line[7:].split(',')]
            if line.startswith('Dialogue:'):
                parts = line[9:].split(',', (len(fields) - 1) if fields else 9)
                names = fields or ['Layer', 'Start', 'End', 'Style', 'Name', 'MarginL', 'MarginR',
                                   'MarginV', 'Effect', 'Text']
                row = dict(zip(names, (p.strip() for p in parts)))
                body = re.sub(r'\{[^}]*\}', '', row.get('Text', ''))
                lines = [s.strip() for s in re.split(r'\\[Nn]', body) if s.strip()]
                events.append({'start': row.get('Start', ''), 'style': row.get('Style', ''), 'lines': lines})
    else:
        for block in re.split(r'\n\s*\n', text.strip()):
            rows = [r for r in block.splitlines() if r.strip()]
            stamp = next((r for r in rows if '-->' in r), None)
            if stamp is None:
                continue
            body = rows[rows.index(stamp) + 1:]
            lines = [re.sub(r'<[^>]+>', '', r).strip() for r in body if r.strip()]
            events.append({'start': stamp.split('-->')[0].strip(), 'style': '', 'lines': lines})
    return events


def check_subs(path):
    if path is None:
        return [result('R19', SKIP, 'файл титров не передан (--subs); прожжённые титры — по кадрам')]
    events = parse_subs(path)
    if not events:
        return [result('R19', FAIL, 'в файле титров нет событий')]
    problems = []
    for ev in events:
        is_title = bool(TITLE_STYLE.search(ev['style']))
        if len(ev['lines']) > 1:
            problems.append((ev['start'], ('титр' if is_title else 'субтитр') + f' в {len(ev["lines"])} строки'))
        if not is_title:
            for line in ev['lines']:
                if len(line) > SUB_MAX_CHARS:
                    problems.append((ev['start'], f'«{line}» — {len(line)} знаков > {SUB_MAX_CHARS}'))
        for line in ev['lines']:
            words = re.findall(r'[\wёЁ-]+', line.lower())
            if len(words) > 1 and words[-1] in HANGING_WORDS:
                problems.append((ev['start'], f'«{line}» — висит «{words[-1]}» в конце строки'))
    if not problems:
        return [result('R19', OK, f'событий титров {len(events)}: одна строка, ≤{SUB_MAX_CHARS} знаков, без висячих слов')]
    return [result('R19', FAIL, prob, at) for at, prob in problems[:20]]


# ---------- содержание кадра ----------

def check_start_frames(frames, fps):
    limit = min(len(frames), int(round(fps * 3)))
    white, black = [], []
    for i in range(limit):
        f = frames[i]
        mean, std = float(f.mean()), float(f.std())
        if std < 6 and mean > 235:
            white.append(i)
        elif std < 6 and mean < 15:
            black.append(i)
    if white:
        return result('R25', FAIL, f'белые однотонные кадры в начале: {len(white)}',
                      f'{fmt_t(white[0] / fps)}–{fmt_t((white[-1] + 1) / fps)}')
    if black:
        return result('R25', WARN, f'тёмные однотонные кадры в начале: {len(black)} (затемнение или пустой кадр?)',
                      f'{fmt_t(black[0] / fps)}–{fmt_t((black[-1] + 1) / fps)}')
    return result('R25', OK, 'в первых 3 с нет пустых кадров')


def check_static(frames, fps):
    p = event_pairs(frames)
    frozen = p < 2.5
    longest, start, run_start = 0, 0, None
    for i, value in enumerate(list(frozen) + [False]):
        if value and run_start is None:
            run_start = i
        elif not value and run_start is not None:
            if i - run_start > longest:
                longest, start = i - run_start, run_start
            run_start = None
    seconds = longest / fps
    if seconds > 2.0:
        return result('R26', WARN, f'застывший отрезок {seconds:.1f} с > 2 с',
                      f'{fmt_t(start / fps)}–{fmt_t((start + longest) / fps)}')
    return result('R26', OK, f'самый длинный застывший отрезок {seconds:.1f} с')


def export_frames(path, info, out_dir):
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    names = []
    duration = max(info['duration'], 0.1)
    for label, t in (('first', 0.0), ('middle', duration / 2), ('last', max(0.0, duration - 1.5 / max(info['fps'], 1)))):
        target = out_dir / f'{Path(path).stem}_{label}.png'
        run(['ffmpeg', '-v', 'error', '-y', '-ss', f'{t:.3f}', '-i', local_input(path), '-frames:v', '1',
             '-update', '1', local_output(target)])
        names.append(str(target))
    return names


# ---------- сборка отчёта ----------

def check_video(path, profile, mechanic=None, source=None, subs=None, project=None,
                mobile=False, frames_dir=None):
    require_tools()
    if profile not in PROFILES:
        raise CheckError('Неизвестный профиль: ' + profile)
    mechanic = mechanic or DEFAULT_MECHANIC[profile]
    if mechanic == 'M5':
        return {'file': str(path), 'profile': profile, 'mechanic': mechanic,
                'results': [result('R09', SKIP, 'M5 — микродвижение кодом, видеофайла нет')], 'manual': []}
    if profile == 'site-scrub' and mechanic not in ('M2', 'M3'):
        raise CheckError('Профиль site-scrub относится к механикам M2 и M3')
    if profile == 'site-loop' and mechanic not in ('M1', 'M4'):
        raise CheckError('Профиль site-loop относится к механикам M1 и M4')
    info = probe(path)
    source_info = probe(source) if source else None
    frames = decode_gray(path, info)
    fps = info['fps'] or 30.0
    res = [check_resolution(info, profile), check_fps(info)]
    res += check_source(info, source_info)
    res.append(check_reverse(frames, fps))
    res.append(check_start_frames(frames, fps))
    if profile == 'reel':
        res += check_reel_audio(path, info, project)
        res += check_subs(subs)
        res.append(check_static(frames, fps))
        res.append(check_events(frames, fps, mechanic))
    else:
        res.append(check_events(frames, fps, mechanic))
        res.append(check_weight(info, mechanic, mobile))
        res += check_codec(path, info, mechanic)
        res += check_site_audio(path, info)
        if profile == 'site-loop':
            res.append(check_seam(frames, fps))
            res.append(check_loop_length(info))
        else:
            res.append(check_keyframes(path, info))
    exported = export_frames(path, info, frames_dir) if frames_dir else []
    manual = [{'rule': rid, 'what': what, 'frames': exported} for rid, what in MANUAL[profile]]
    summary = {s: sum(1 for r in res if r['status'] == s) for s in (OK, FAIL, WARN, SKIP)}
    return {
        'file': str(path), 'profile': profile, 'mechanic': mechanic, 'project': project,
        'video': {k: info[k] for k in ('width', 'height', 'fps', 'duration', 'codec', 'size')},
        'results': res, 'manual': manual, 'summary': summary,
    }


def render_text(report):
    lines = [f'Файл: {report["file"]}',
             f'Профиль: {report["profile"]}; механика: {report.get("mechanic") or "—"}; '
             f'проект: {report.get("project") or "—"}']
    video = report.get('video')
    if video:
        lines.append(f'Видео: {video["width"]}×{video["height"]}, {video["fps"]:.3g} к/с, '
                     f'{video["duration"]:.2f} с, {video["codec"]}, {video["size"] / KB:.0f} КБ')
    lines.append('')
    for r in report['results']:
        tail = f' [{r["at"]}]' if r['at'] else ''
        lines.append(f'{MARK[r["status"]]} {r["rule"]} {r["detail"]}{tail}')
    if report.get('manual'):
        lines.append('')
        lines.append('Проверить глазами (модель или человек):')
        for m in report['manual']:
            lines.append(f'— {m["rule"]} {m["what"]}')
        frames = report['manual'][0]['frames']
        if frames:
            lines.append('Кадры: ' + ', '.join(frames))
    s = report.get('summary')
    if s:
        lines.append('')
        lines.append(f'Итог: ✔ {s[OK]} · ✘ {s[FAIL]} · ⚠ {s[WARN]} · — {s[SKIP]}; '
                     f'вручную {len(report.get("manual", []))}. '
                     + ('Ролик НЕ показывать Владу до исправления ✘.' if s[FAIL] else 'Автопроверка без ✘.'))
    return '\n'.join(lines)


def main(argv=None):
    parser = argparse.ArgumentParser(description='Проверка ролика по tools/reels-check/RULES.md')
    parser.add_argument('video')
    parser.add_argument('--profile', required=True, choices=PROFILES)
    parser.add_argument('--mechanic', choices=MECHANICS)
    parser.add_argument('--source', help='исходник от генератора или съёмки (для R04, R05)')
    parser.add_argument('--subs', help='файл титров .srt или .ass (R19)')
    parser.add_argument('--project', help='код проекта: alvi, avokado, palitra, synapse (R16)')
    parser.add_argument('--mobile', action='store_true', help='блочный ролик для телефона: лимит 350 КБ')
    parser.add_argument('--frames-dir', help='куда выгрузить первый, средний и последний кадр')
    parser.add_argument('--json', action='store_true')
    args = parser.parse_args(argv)
    try:
        report = check_video(args.video, args.profile, args.mechanic, args.source, args.subs,
                             args.project, args.mobile, args.frames_dir)
    except CheckError as error:
        print('reels-check: ' + str(error), file=sys.stderr)
        return 2
    except Exception as error:  # любой сбой — ошибка запуска, а не «брак ролика»
        print(f'reels-check: внутренняя ошибка {type(error).__name__}: {error}', file=sys.stderr)
        return 2
    if args.json:
        print(json.dumps(report, ensure_ascii=False, indent=2, default=str))
    else:
        print(render_text(report))
    return 1 if any(r['status'] == FAIL for r in report['results']) else 0


if __name__ == '__main__':
    sys.exit(main())
