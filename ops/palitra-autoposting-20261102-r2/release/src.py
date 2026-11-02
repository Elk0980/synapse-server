#!/usr/bin/env python3
"""Только чтение кода CRM внутри контейнера (не данных, не env).
python3 src.py [content] find СЛОВО            — файлы и строки /app/*.js с этим словом
python3 src.py show ФАЙЛ СТРОКА N    — N строк файла начиная со СТРОКИ (обрезка 230 символов)
python3 src.py grep ФАЙЛ СЛОВО ДО    — вокруг каждого вхождения СЛОВА по ДО символов
"""
import subprocess, sys

C = ["docker", "exec", "synapse-crm-1"]
if len(sys.argv) > 1 and sys.argv[1] in ("crm", "content", "chat"):
    C = ["docker", "exec", "synapse-%s-1" % sys.argv.pop(1)]


def run(args):
    return subprocess.run(C + args, capture_output=True, timeout=60).stdout.decode("utf-8", "replace")


def main():
    mode = sys.argv[1]
    if mode == "find":
        out = run(["sh", "-c", "grep -rn -F --include=*.js --exclude-dir=node_modules -- \"$0\" /app | cut -c1-160 | head -40", sys.argv[2]])
        print(out)
    elif mode == "show":
        name, start, n = sys.argv[2], int(sys.argv[3]), int(sys.argv[4])
        lines = run(["cat", "/app/" + name]).split("\n")
        for i in range(start - 1, min(len(lines), start - 1 + n)):
            print(i + 1, lines[i][:230])
    elif mode == "grep":
        name, word, width = sys.argv[2], sys.argv[3], int(sys.argv[4])
        text = run(["cat", "/app/" + name])
        pos = 0
        while True:
            pos = text.find(word, pos)
            if pos < 0:
                break
            line = text.count("\n", 0, pos) + 1
            print("@", line, text[max(0, pos - width):pos + width].replace("\n", " | "))
            pos += len(word)


if __name__ == "__main__":
    main()
