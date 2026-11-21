"""Тесты check.py на синтетических роликах, которые генерирует ffmpeg.

Запуск: python3 -m unittest discover -s tools/reels-check -p 'test_*.py'
"""
import contextlib
import io
import json
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import check  # noqa: E402

HAVE_FFMPEG = bool(shutil.which('ffmpeg') and shutil.which('ffprobe'))


def ff(*args):
    subprocess.run(['ffmpeg', '-v', 'error', '-y', *args], check=True)


def statuses(report, rule):
    return [r['status'] for r in report['results'] if r['rule'] == rule]


class RulesFileTest(unittest.TestCase):
    def test_rules_cover_every_id_used_by_script(self):
        text = (HERE / 'RULES.md').read_text(encoding='utf-8')
        defined = set(re.findall(r'^\| (R\d\d) \|', text, flags=re.M))
        self.assertGreaterEqual(len(defined), 15)
        used = set(re.findall(r"'(R\d\d)'", (HERE / 'check.py').read_text(encoding='utf-8')))
        self.assertTrue(used, 'скрипт не ссылается на правила')
        self.assertEqual(used - defined, set(), 'в RULES.md нет правил, на которые ссылается скрипт')

    def test_every_rule_has_source_auto_and_status(self):
        text = (HERE / 'RULES.md').read_text(encoding='utf-8')
        for row in re.findall(r'^\| R\d\d \|.*$', text, flags=re.M):
            cells = [c.strip() for c in row.strip('|').split('|')]
            self.assertEqual(len(cells), 6, row)
            self.assertRegex(cells[3], r'^(да|частично|нет)', row)
            self.assertRegex(cells[5], r'^(действует|отменено)', row)
            self.assertTrue(cells[2], row)


class SubtitlesTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())

    def tearDown(self):
        shutil.rmtree(self.tmp)

    def write(self, name, text):
        path = self.tmp / name
        path.write_text(text, encoding='utf-8')
        return path

    def test_long_subtitle_fails_short_passes(self):
        path = self.write('long.srt', '1\n00:00:00,000 --> 00:00:01,000\nСантиметры ≠ жир\n\n'
                                    '2\n00:00:01,000 --> 00:00:02,000\nЧто спросить мастеру\n')
        # «Что спросить мастеру» — 20 знаков: должно ловиться
        res = check.check_subs(path)
        self.assertEqual([r['status'] for r in res], [check.FAIL])
        path = self.write('short.srt', '1\n00:00:00,000 --> 00:00:01,000\nСантиметры ≠ жир\n')
        self.assertEqual([r['status'] for r in check.check_subs(path)], [check.OK])

    def test_two_lines_and_hanging_word_fail(self):
        path = self.write('bad.srt', '1\n00:00:00,000 --> 00:00:01,000\nМассаж и\nжир\n')
        details = ' '.join(r['detail'] for r in check.check_subs(path))
        self.assertIn('2 строки', details)
        self.assertIn('висит «и»', details)

    def test_ass_title_may_be_long_but_single_line(self):
        ass = ('[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n'
               'Dialogue: 0,0:00:00.00,0:00:02.00,Title,,0,0,0,,{\\b1}Массаж не равно похудение\n'
               'Dialogue: 0,0:00:00.00,0:00:02.00,Sub,,0,0,0,,Сантиметры ≠ жир\n')
        path = self.write('r.ass', ass)
        self.assertEqual([r['status'] for r in check.check_subs(path)], [check.OK])
        path = self.write('r2.ass', ass.replace('Массаж не', 'Массаж\\Nне'))
        self.assertEqual([r['status'] for r in check.check_subs(path)], [check.FAIL])

    def test_top_matches_only_whole_word(self):
        ass = ('[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n'
               'Dialogue: 0,0:00:00.00,0:00:02.00,Desktop,,0,0,0,,Массаж не равно похудение\n')
        path = self.write('desk.ass', ass)
        self.assertEqual([r['status'] for r in check.check_subs(path)], [check.FAIL])  # субтитр > 17 знаков
        path = self.write('top.ass', ass.replace('Desktop', 'Top'))
        self.assertEqual([r['status'] for r in check.check_subs(path)], [check.OK])


class ExitCodeTest(unittest.TestCase):
    def test_missing_numpy_exits_2(self):
        code = ("import sys, runpy; sys.modules['numpy'] = None; "
                "sys.argv = ['check.py', 'x.mp4', '--profile', 'reel']; "
                f"runpy.run_path({str(HERE / 'check.py')!r}, run_name='__main__')")
        proc = subprocess.run([sys.executable, '-c', code], capture_output=True, text=True)
        self.assertEqual(proc.returncode, 2, proc.stderr)
        self.assertIn('numpy', proc.stderr)

    def test_unexpected_exception_exits_2(self):
        original = check.check_video
        def boom(*args, **kwargs):
            raise RuntimeError('сбой')
        check.check_video = boom
        try:
            with redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(check.main(['x.mp4', '--profile', 'reel']), 2)
        finally:
            check.check_video = original

    def test_urls_protocols_and_missing_files_are_rejected(self):
        for arg in ('concat:a.mp4|b.mp4', 'http://example.com/a.mp4', 'pipe:0', '/nonexistent/clip.mp4'):
            with self.subTest(arg=arg):
                with self.assertRaises(check.CheckError):
                    check.local_input(arg)
        with tempfile.NamedTemporaryFile(suffix='.mp4') as tmp:
            self.assertTrue(check.local_input(tmp.name).startswith('file:/'))


@unittest.skipUnless(HAVE_FFMPEG, 'нужны ffmpeg и ffprobe')
class VideoTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp())
        t = cls.tmp
        h264 = ['-c:v', 'libx264', '-pix_fmt', 'yuv420p']
        # прямой ролик и палиндром из него
        ff('-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=30:duration=2', *h264, str(t / 'fwd.mp4'))
        ff('-i', str(t / 'fwd.mp4'), '-filter_complex',
           '[0:v]split[a][b];[b]reverse[r];[a][r]concat=n=2:v=1[v]', '-map', '[v]', *h264, str(t / 'pal.mp4'))
        # петля с направленным движением и ровным швом: полосы сдвигаются на период за 4 с
        ff('-f', 'lavfi', '-i', "color=c=gray:size=320x180:rate=30:duration=4,format=gray,"
           "geq=lum='128+60*sin(2*PI*(3*X/W+T/4))'", *h264, '-crf', '18', str(t / 'loop.mp4'))
        # тяжёлый ролик: шум, почти без сжатия
        ff('-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=30:duration=4', '-vf', 'noise=alls=80:allf=t+u',
           *h264, '-crf', '4', str(t / 'heavy.mp4'))
        # одно необратимое событие: на 1,5 с появляется и остаётся белый квадрат
        ff('-f', 'lavfi', '-i', 'color=c=0x336699:size=320x180:rate=30:duration=4', '-vf',
           "drawbox=x=120:y=60:w=80:h=60:color=white:t=fill:enable='gte(t,1.5)'", *h264, '-g', '12',
           str(t / 'event.mp4'))
        ff('-i', str(t / 'event.mp4'), *h264, '-g', '60', str(t / 'event_gop60.mp4'))
        # белый «лоадер» в начале
        ff('-f', 'lavfi', '-i', 'color=c=white:size=320x180:rate=30:duration=1', '-f', 'lavfi', '-i',
           'testsrc=size=320x180:rate=30:duration=3', '-filter_complex', '[0:v][1:v]concat=n=2:v=1[v]',
           '-map', '[v]', *h264, str(t / 'loader.mp4'))
        # рилс 1080×1920 со звуком и без
        ff('-f', 'lavfi', '-i', 'testsrc2=size=1080x1920:rate=30:duration=2', '-f', 'lavfi', '-i',
           'sine=frequency=440:duration=2', '-af', 'volume=-6dB', *h264, '-c:a', 'aac', '-shortest',
           str(t / 'reel_audio.mp4'))
        ff('-f', 'lavfi', '-i', 'testsrc2=size=1080x1920:rate=30:duration=2', *h264, str(t / 'reel_mute.mp4'))
        # горизонтальный исходник и вертикаль, полученная кропом с увеличением
        ff('-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=2', *h264, str(t / 'src_land.mp4'))
        ff('-i', str(t / 'src_land.mp4'), '-vf', 'crop=202:360,scale=1080:1920:flags=lanczos', *h264,
           str(t / 'reel_crop.mp4'))

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp)

    def run_cli(self, *args):
        buf = io.StringIO()
        with redirect_stdout(buf):
            code = check.main([*args, '--json'])
        return code, json.loads(buf.getvalue())

    def test_palindrome_is_caught(self):
        code, report = self.run_cli(str(self.tmp / 'pal.mp4'), '--profile', 'site-loop', '--mechanic', 'M1')
        self.assertEqual(code, 1)
        self.assertIn(check.FAIL, statuses(report, 'R06'))

    def test_ping_pong_inside_longer_clip_is_caught(self):
        t = self.tmp
        ff('-i', str(t / 'fwd.mp4'), '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30:duration=2',
           '-filter_complex', '[0:v]split[a][b];[b]trim=start=1,setpts=PTS-STARTPTS,reverse[r];'
           '[1:v]format=yuv420p[c];[a][r][c]concat=n=3:v=1[v]', '-map', '[v]',
           '-c:v', 'libx264', '-pix_fmt', 'yuv420p', str(t / 'pingpong.mp4'))
        report = check.check_video(t / 'pingpong.mp4', 'site-scrub', 'M3')
        self.assertEqual(statuses(report, 'R06'), [check.FAIL])
        at = [r['at'] for r in report['results'] if r['rule'] == 'R06'][0]
        self.assertRegex(at, r'кадр (5[7-9]|6[0-2])\)')  # разворот около 2 с

    def test_static_clip_skips_reverse(self):
        ff('-f', 'lavfi', '-i', 'color=c=0x336699:size=320x180:rate=30:duration=3',
           '-c:v', 'libx264', '-pix_fmt', 'yuv420p', str(self.tmp / 'static.mp4'))
        report = check.check_video(self.tmp / 'static.mp4', 'site-loop', 'M1')
        self.assertEqual(statuses(report, 'R06'), [check.SKIP])

    def test_fps_above_30_fails(self):
        ff('-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=60:duration=1',
           '-c:v', 'libx264', '-pix_fmt', 'yuv420p', str(self.tmp / 'fps60.mp4'))
        report = check.check_video(self.tmp / 'fps60.mp4', 'site-scrub', 'M3')
        self.assertEqual(statuses(report, 'R03'), [check.FAIL])

    def test_avokado_without_voice_fails(self):
        report = check.check_video(self.tmp / 'reel_mute.mp4', 'reel', project='avokado')
        self.assertEqual(statuses(report, 'R16'), [check.FAIL])

    def test_forward_clip_is_not_reverse(self):
        report = check.check_video(self.tmp / 'fwd.mp4', 'site-scrub', 'M3')
        self.assertEqual(statuses(report, 'R06'), [check.OK])

    def test_smooth_loop_passes(self):
        code, report = self.run_cli(str(self.tmp / 'loop.mp4'), '--profile', 'site-loop', '--mechanic', 'M1')
        self.assertEqual(code, 0, report['results'])
        self.assertEqual(statuses(report, 'R07'), [check.OK])
        self.assertEqual(statuses(report, 'R06'), [check.OK])
        self.assertEqual(statuses(report, 'R09'), [check.OK])

    def test_hard_seam_fails(self):
        report = check.check_video(self.tmp / 'fwd.mp4', 'site-loop', 'M1')
        self.assertEqual(statuses(report, 'R07'), [check.FAIL])
        self.assertEqual(statuses(report, 'R08'), [check.FAIL])  # 2 с < 3 с

    def test_extra_weight_is_caught(self):
        path = self.tmp / 'heavy.mp4'
        self.assertGreater(path.stat().st_size, 600 * 1024)
        code, report = self.run_cli(str(path), '--profile', 'site-loop', '--mechanic', 'M1')
        self.assertEqual(code, 1)
        self.assertEqual(statuses(report, 'R11'), [check.FAIL])

    def test_mobile_limit_is_stricter(self):
        report = check.check_video(self.tmp / 'loop.mp4', 'site-loop', 'M1', mobile=True)
        detail = [r['detail'] for r in report['results'] if r['rule'] == 'R11'][0]
        self.assertIn('350 КБ', detail)

    def test_event_count_by_mechanic(self):
        m1 = check.check_video(self.tmp / 'event.mp4', 'site-loop', 'M1')
        self.assertEqual(statuses(m1, 'R09'), [check.FAIL])
        m2 = check.check_video(self.tmp / 'event.mp4', 'site-scrub', 'M2')
        self.assertEqual(statuses(m2, 'R09'), [check.OK])
        at = [r['at'] for r in m2['results'] if r['rule'] == 'R09'][0]
        self.assertIn('1.', at)

    def test_keyframes_for_scrub(self):
        ok = check.check_video(self.tmp / 'event.mp4', 'site-scrub', 'M2')
        self.assertEqual(statuses(ok, 'R13'), [check.OK])
        bad = check.check_video(self.tmp / 'event_gop60.mp4', 'site-scrub', 'M2')
        self.assertEqual(statuses(bad, 'R13'), [check.FAIL])

    def test_white_loader_at_start_fails(self):
        report = check.check_video(self.tmp / 'loader.mp4', 'reel')
        self.assertEqual(statuses(report, 'R25'), [check.FAIL])

    def test_reel_format_and_audio_policy(self):
        mute = check.check_video(self.tmp / 'reel_mute.mp4', 'reel', project='alvi')
        self.assertEqual(statuses(mute, 'R01'), [check.OK])
        self.assertEqual(statuses(mute, 'R16'), [check.OK])
        alvi = check.check_video(self.tmp / 'reel_audio.mp4', 'reel', project='alvi')
        self.assertIn(check.FAIL, statuses(alvi, 'R16'))
        avokado = check.check_video(self.tmp / 'reel_audio.mp4', 'reel', project='avokado')
        self.assertEqual(statuses(avokado, 'R16'), [check.OK])
        self.assertEqual(len(statuses(avokado, 'R18')), 1)
        unknown = check.check_video(self.tmp / 'reel_audio.mp4', 'reel')
        self.assertEqual(statuses(unknown, 'R16'), [check.SKIP])

    def test_landscape_reel_fails(self):
        report = check.check_video(self.tmp / 'fwd.mp4', 'reel')
        self.assertEqual(statuses(report, 'R01'), [check.FAIL])

    def test_crop_and_upscale_from_source(self):
        report = check.check_video(self.tmp / 'reel_crop.mp4', 'reel', source=self.tmp / 'src_land.mp4')
        self.assertEqual(statuses(report, 'R04'), [check.FAIL])
        self.assertEqual(statuses(report, 'R05'), [check.FAIL])
        report = check.check_video(self.tmp / 'reel_crop.mp4', 'reel')
        self.assertEqual(statuses(report, 'R05'), [check.SKIP])

    def test_frames_export_for_manual_rules(self):
        out = self.tmp / 'frames'
        report = check.check_video(self.tmp / 'loop.mp4', 'site-loop', 'M1', frames_dir=out)
        self.assertEqual(len(list(out.glob('*.png'))), 3)
        self.assertTrue(any(m['rule'] == 'R21' for m in report['manual']))

    def test_text_report_marks(self):
        report = check.check_video(self.tmp / 'pal.mp4', 'site-loop', 'M1')
        text = check.render_text(report)
        self.assertIn('✘ R06', text)
        self.assertIn('НЕ показывать', text)

    def test_wrong_mechanic_for_profile_is_usage_error(self):
        buf = io.StringIO()
        with redirect_stdout(buf):
            code = check.main([str(self.tmp / 'loop.mp4'), '--profile', 'site-loop', '--mechanic', 'M2'])
        self.assertEqual(code, 2)


if __name__ == '__main__':
    unittest.main()
