#!/usr/bin/env python3
"""Human-only first setup; explicit --pair enables bounded Telegram confirmation."""

import getpass
import os
from pathlib import PurePosixPath
import re
import stat
import sys
import warnings
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError


CONFIG_DIR = "/etc/synapse/eva"
TOKEN_NAME = "telegram-token"
ENV_NAME = "eva.env"


class SetupError(Exception):
    """Messages must be static and must never contain operator input."""


def validate_owner_id(value):
    if not re.fullmatch(r"[1-9][0-9]{0,15}", value) or int(value) > 2**53 - 1:
        raise SetupError("Нужен положительный числовой Telegram user ID владельца.")
    return value


def validate_timezone(value):
    value = value or "Etc/UTC"
    if not re.fullmatch(r"[A-Za-z0-9_+./-]{1,128}", value):
        raise SetupError("Нужен часовой пояс IANA, например Asia/Irkutsk.")
    try:
        ZoneInfo(value)
    except (ValueError, ZoneInfoNotFoundError):
        raise SetupError("Часовой пояс не найден; проверьте IANA и установленную tzdata.") from None
    return value


def validate_volume(value):
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{1,127}", value):
        raise SetupError("Нужно точное имя согласованного Docker volume только для сокета задач.")
    return value


def validate_token(value):
    if (not re.fullmatch(r"[1-9][0-9]{4,15}:[A-Za-z0-9_-]{20,200}", value)
            or int(value.split(":", 1)[0]) > 2**53 - 1):
        raise SetupError("Формат токена не распознан. Повторите личный ввод из BotFather.")
    return value


def validate_directory(info, *, private=False):
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0:
        raise SetupError("Каталог должен принадлежать root и не быть ссылкой.")
    if info.st_mode & 0o022:
        raise SetupError("Каталог доступен другим на запись; настройка остановлена.")
    if private and stat.S_IMODE(info.st_mode) != 0o700:
        raise SetupError("Существующий каталог Eva должен иметь права 0700; права не менялись.")


def open_private_directory(path=CONFIG_DIR):
    """Walk using directory FDs and O_NOFOLLOW, never follow a path component link."""
    parsed = PurePosixPath(path)
    if not parsed.is_absolute() or ".." in parsed.parts or str(parsed) != path or path == "/":
        raise SetupError("Нужен фиксированный абсолютный безопасный путь настройки.")
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    current = os.open("/", flags)
    try:
        validate_directory(os.fstat(current))
        for index, name in enumerate(parsed.parts[1:]):
            final = index == len(parsed.parts) - 2
            try:
                child = os.open(name, flags, dir_fd=current)
            except FileNotFoundError:
                # /etc must already exist; only our two private directories may be created.
                if path != CONFIG_DIR or name not in ("synapse", "eva"):
                    raise SetupError("Родительский каталог настройки отсутствует.") from None
                try:
                    os.mkdir(name, 0o700, dir_fd=current)
                except FileExistsError:
                    pass  # A simultaneous creator still has to pass the checks below.
                child = os.open(name, flags, dir_fd=current)
            try:
                validate_directory(os.fstat(child), private=final)
            except BaseException:
                os.close(child)
                raise
            os.close(current)
            current = child
        return current
    except BaseException:
        os.close(current)
        raise


def refuse_existing(directory_fd):
    for name in (TOKEN_NAME, ENV_NAME):
        try:
            os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
        except FileNotFoundError:
            continue
        raise SetupError("Файлы настройки уже существуют. Ничего не прочитано и не перезаписано.")


def write_private_file(directory_fd, name, data):
    if name not in (TOKEN_NAME, ENV_NAME):
        raise SetupError("Недопустимое имя файла настройки.")
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW
    file_fd = os.open(name, flags, 0o600, dir_fd=directory_fd)
    try:
        view = memoryview(data)
        while view:
            written = os.write(file_fd, view)
            if written <= 0:
                raise SetupError("Не удалось записать настройку; требуется локальная проверка файлов.")
            view = view[written:]
        os.fsync(file_fd)
    finally:
        os.close(file_fd)


def save_configuration(directory_fd, token, owner_id, timezone, volume):
    token = validate_token(token)
    owner_id = validate_owner_id(owner_id)
    timezone = validate_timezone(timezone)
    volume = validate_volume(volume)
    refuse_existing(directory_fd)
    metadata = (
        f"EVA_OWNER_USER_ID={owner_id}\n"
        f"EVA_TIMEZONE={timezone}\n"
        f"EVA_TASK_SOCKET_VOLUME={volume}\n"
    )
    # No chmod, replacement, secret-derived error, network call or automatic startup.
    # If interrupted between these exclusive writes, an operator checks the partial
    # setup locally; a rerun refuses either existing file instead of overwriting it.
    write_private_file(directory_fd, TOKEN_NAME, (token + "\n").encode("ascii"))
    write_private_file(directory_fd, ENV_NAME, metadata.encode("ascii"))
    os.fsync(directory_fd)


def read_hidden_token():
    with warnings.catch_warnings():
        # getpass must never fall back to echoed input.
        warnings.simplefilter("error", getpass.GetPassWarning)
        return validate_token(getpass.getpass("Вставьте токен BotFather (ввод скрыт): "))


def lock_setup(directory_fd):
    # Linux flock on this directory FD: no stale lock file, released on close/exit.
    import fcntl
    try:
        fcntl.flock(directory_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        raise SetupError("Другая настройка уже выполняется. Ничего не сохранено.") from None


def read_pairing_code(_seconds):
    with warnings.catch_warnings():
        warnings.simplefilter("error", getpass.GetPassWarning)
        return getpass.getpass("Если это ВАШ личный Telegram, подтвердите его кодом из Eva (ввод скрыт): ")


def confirm_owner(token, bot_username):
    import pairing
    import signal
    # SIGALRM interrupts network reads AND blocking getpass, including no Enter.
    if signal.getitimer(signal.ITIMER_REAL) != (0.0, 0.0):
        raise SetupError("Консоль уже занята таймером. Настройка остановлена.")
    def expired(_signum, _frame):
        raise pairing.PairingError("Срок подтверждения истёк. Настройка не сохранена.")
    old_handler = signal.signal(signal.SIGALRM, expired)
    signal.setitimer(signal.ITIMER_REAL, 300)
    try:
        result = pairing.pair_owner(
            pairing.TelegramAPI(token), bot_username, int(token.split(":", 1)[0]),
            show_link=lambda link: print("Откройте лично своим Telegram и нажмите Start; ссылку не пересылайте:\n" + link),
            confirm_code=read_pairing_code)
        pairing.ensure_fresh(result["expires_at"])
        return result
    except pairing.PairingError:
        raise SetupError("Подтверждение Telegram не завершено. Настройка не сохранена; повторите позже.") from None
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, old_handler)


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    pair_mode = len(argv) == 4 and argv[0] == "--pair"
    if argv and not pair_mode:
        print("Запуск: setup.py либо setup.py --pair BOT_USERNAME TIMEZONE SOCKET_VOLUME", file=sys.stderr)
        return 2
    if sys.platform != "linux" or os.geteuid() != 0:
        print("Настройку запускает человек через sudo на Linux-сервере.", file=sys.stderr)
        return 2
    if not sys.stdin.isatty() or not sys.stderr.isatty() or (pair_mode and not sys.stdout.isatty()):
        print("Нужна личная интерактивная консоль TTY; pipe и перенаправление запрещены.", file=sys.stderr)
        return 2
    directory_fd = None
    try:
        # Newly created directories/files use exactly 0700/0600. Existing modes stay intact.
        os.umask(0o077)
        if pair_mode:
            bot_username = argv[1]
            if (not re.fullmatch(r"[A-Za-z][A-Za-z0-9_]{4,31}", bot_username)
                    or not bot_username.lower().endswith("bot")):
                raise SetupError("Нужно подтверждённое публичное имя отдельного бота без @.")
            timezone = validate_timezone(argv[2])
            volume = validate_volume(argv[3])
        directory_fd = open_private_directory()
        lock_setup(directory_fd)
        refuse_existing(directory_fd)
        print("Eva: только сохранение локальной настройки. Бот не запускается.")
        if pair_mode:
            print("После личного ввода токена — пять минут на подтверждение своего Telegram. До успеха файлы не сохраняются.")
            token = read_hidden_token()
            paired = confirm_owner(token, bot_username)
            owner_id = validate_owner_id(paired["owner_id"])
            # Check again immediately before the existing exclusive file writes.
            import pairing
            try:
                pairing.ensure_fresh(paired["expires_at"])
            except pairing.PairingError:
                raise SetupError("Срок подтверждения истёк. Настройка не сохранена.") from None
        else:
            owner_id = validate_owner_id(input("Ваш проверенный числовой Telegram user ID: "))
            timezone = validate_timezone(input("Часовой пояс IANA [Etc/UTC]: "))
            volume = validate_volume(input("Имя согласованного существующего volume только для сокета задач (не CRM): "))
            token = read_hidden_token()
        save_configuration(directory_fd, token, owner_id, timezone, volume)
        print("Сохранено в /etc/synapse/eva: каталог 0700, новые файлы 0600. Бот не запускался.")
        return 0
    except SetupError as error:
        print(str(error), file=sys.stderr)
        return 1
    except (OSError, EOFError, KeyboardInterrupt, getpass.GetPassWarning):
        # Filesystem/getpass errors can include input or paths; never print their repr.
        print("Настройка остановлена. Ничего не запускалось; проверьте файлы локально перед повтором.", file=sys.stderr)
        return 1
    finally:
        if directory_fd is not None:
            os.close(directory_fd)


if __name__ == "__main__":
    raise SystemExit(main())
