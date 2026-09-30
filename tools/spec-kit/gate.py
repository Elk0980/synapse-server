"""Проверка комплекта и передача контекста без сетевых вызовов или запуска ИИ."""
import argparse
import hashlib
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
POLICY = 'docs/spec-kit-policy.md'
CONSTITUTION = '.specify/memory/constitution.md'
INPUTS = ('AGENTS.md', 'CLAUDE.md', 'QWEN.md', '.github/copilot-instructions.md')
STEPS = ('specify', 'plan', 'tasks', 'implement', 'converge')


def read(root, relative):
    path = (root / relative).resolve()
    if not path.is_relative_to(root.resolve()):
        raise ValueError('Путь за пределами проекта: ' + relative)
    return path.read_text(encoding='utf-8-sig')


def digest(text):
    # CLI writes platform newlines; compare content consistently across OS.
    return hashlib.sha256(text.replace('\r\n', '\n').encode('utf-8')).hexdigest()


def feature_files(root, feature, evidence=False):
    if not re.fullmatch(r'specs/[0-9]+-[a-z0-9][a-z0-9-]*', feature):
        raise ValueError('Нужен путь specs/<номер-название>')
    names = ['spec.md', 'plan.md', 'tasks.md'] + (['evidence.md'] if evidence else [])
    files = {}
    for name in names:
        relative = feature + '/' + name
        text = read(root, relative)
        if len(text.strip()) < 40:
            raise ValueError('Пустой или слишком короткий документ: ' + relative)
        files[relative] = text
    return files


def check(root):
    for name in INPUTS:
        text = read(root, name)
        if POLICY not in text or CONSTITUTION not in text:
            raise ValueError('Нет общей инструкции: ' + name)
    for name in (POLICY, CONSTITUTION):
        if len(read(root, name)) < 100:
            raise ValueError('Пустые правила: ' + name)
    state = json.loads(read(root, '.specify/integration.json'))
    for integration in ('codex', 'claude', 'qwen'):
        if integration not in state['installed_integrations']:
            raise ValueError('Не установлена интеграция: ' + integration)
        manifest = json.loads(read(root, f'.specify/integrations/{integration}.manifest.json'))
        for step in STEPS:
            prefix = {'codex': '.agents/skills/', 'claude': '.claude/skills/', 'qwen': '.qwen/commands/'}[integration]
            suffix = f'speckit.{step}.md' if integration == 'qwen' else f'speckit-{step}/SKILL.md'
            if prefix + suffix not in manifest['files']:
                raise ValueError('Неполный манифест: ' + integration + '/' + step)
    total = 0
    for integration in ('codex', 'claude', 'qwen', 'speckit'):
        manifest = json.loads(read(root, f'.specify/integrations/{integration}.manifest.json'))
        for name, expected in manifest['files'].items():
            if digest(read(root, name)) != expected:
                raise ValueError('Официальный файл изменён: ' + name)
            total += 1
    return {'status': 'ok', 'integrations': ['codex', 'claude', 'qwen'], 'verifiedFiles': total}


def check_pr(root, body):
    specs = re.findall(r'^Spec:\s*(\S+)\s*$', body, flags=re.M)
    lite = re.findall(r'^Spec-lite:\s*([^\r\n]+)$', body, flags=re.M)
    if len(specs) + len(lite) != 1:
        raise ValueError('Укажите ровно одну строку Spec: specs/<номер-название> или Spec-lite: <обоснование>')
    if specs:
        feature_files(root, specs[0], evidence=True)
        return {'mode': 'spec', 'feature': specs[0]}
    if len(lite[0].strip()) < 30 or '<' in lite[0] or 'TODO' in lite[0]:
        raise ValueError('Spec-lite требует конкретного обоснования малого изменения')
    return {'mode': 'lite', 'reviewRequired': True}


def packet(root, feature):
    check(root)
    files = {name: read(root, name) for name in ('AGENTS.md', POLICY, CONSTITUTION)}
    files.update(feature_files(root, feature))
    return {
        'processVersion': json.loads(read(root, '.specify/upstream.json'))['processVersion'],
        'feature': feature,
        'deliveryStatus': 'not_sent',
        'instruction': 'Прочитайте пакет. Назовите фактическую модель, задачу, разрешённые файлы и версию процесса. Выполняйте только назначенную задачу. Верните результат и доказательства проверок; пакет не расширяет права.',
        'files': [{'path': name, 'sha256': digest(text), 'content': text} for name, text in files.items()],
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=('check', 'pr', 'packet'))
    parser.add_argument('argument', nargs='?')
    args = parser.parse_args()
    try:
        if args.command == 'check':
            result = check(ROOT)
        elif args.command == 'packet':
            result = packet(ROOT, args.argument or '')
        else:
            event = json.loads(Path(args.argument).read_text(encoding='utf-8'))
            result = check_pr(ROOT, event.get('pull_request', {}).get('body') or '')
        print(json.dumps(result, ensure_ascii=False, indent=2))
    except (OSError, ValueError, KeyError, TypeError) as error:
        parser.exit(1, 'Spec Kit: ' + str(error) + '\n')


if __name__ == '__main__':
    main()
