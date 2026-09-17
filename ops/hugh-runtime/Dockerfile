# Приватный рантайм Hugh. Образ на glibc (bookworm-slim), потому что официальные сборки
# @openai/codex распространяются для gnu-целей; alpine здесь не используется намеренно.
FROM node:24-bookworm-slim

ARG CODEX_VERSION=0.154.0
ARG NPM_REGISTRY=https://registry.npmjs.org/
# Пусто — выбирается первый согласованный слаг из встроенного набора (см. model-catalog.js).
ARG HUGH_MODEL_SLUG=

# Доверенные корневые сертификаты ставятся явно официальным пакетом Debian. На проде в
# контейнере не оказалось /etc/ssl/certs/ca-certificates.crt, и клиент Codex не смог
# проверить цепочку: account/login/start падал на «error sending request» к auth.openai.com.
# Полагаться на то, что базовый образ принесёт хранилище с собой, нельзя — ставим сами.
# Проверка сертификатов при этом остаётся включённой: ни NODE_TLS_REJECT_UNAUTHORIZED,
# ни --insecure, ни подменённого хранилища здесь нет и быть не должно.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && update-ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Точная закреплённая версия. Сборка падает, если бинарь отрапортовал другую.
RUN npm config set registry "${NPM_REGISTRY}" \
 && npm install -g "@openai/codex@${CODEX_VERSION}" \
 && codex --version \
 && codex --version | grep -qx "codex-cli ${CODEX_VERSION}"

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY *.js ./
COPY test-support ./test-support

# COPY сохраняет права файлов из контекста сборки. На сервере рабочая копия создаётся
# автовыкладкой, и если git работал под umask 077, файлы приходят с правами 0600, а
# каталоги — 0700. После USER hugh такой /app недоступен даже на чтение: Node падает на
# «Cannot read package config /app/package.json: permission denied» ещё до первой строки.
#
# Приводим к предсказуемым правам ровно то, что скопировали из контекста. Владельцем
# остаётся root, право записи остаётся только у root — открывается только чтение и обход.
# node_modules намеренно не трогаем: его создал npm внутри образа, и там есть исполняемые
# файлы, которым нельзя снимать бит выполнения.
RUN chmod 0755 /app /app/test-support \
 && chmod 0644 /app/package.json /app/package-lock.json /app/*.js \
 && find /app/test-support -type d -exec chmod 0755 {} + \
 && find /app/test-support -type f -exec chmod 0644 {} +

RUN useradd --uid 10001 --create-home --shell /usr/sbin/nologin hugh \
 && mkdir -p /workspace /data /app/build \
 && chown -R hugh:hugh /workspace /data /app/build \
 && chmod 0755 /workspace

USER hugh

# Шаг 0. Хранилище корневых сертификатов обязано быть на месте и читаться рабочим
# пользователем: именно от него зависит проверка TLS при входе в подписку. Файл разбирается
# по-настоящему (X509), пустой или повреждённый набор останавливает сборку.
RUN node test-support/check-ca-bundle.js

# Шаг 1. Доверенный каталог моделей из официального встроенного набора самого бинаря.
# Ни сети, ни авторизации: cli/src/main.rs:2383 отдаёт bundled_models_response.
RUN mkdir -p /tmp/bootstrap/home \
 && CODEX_HOME=/tmp/bootstrap HOME=/tmp/bootstrap/home codex debug models --bundled > /tmp/bundled-models.json \
 && node test-support/build-restricted-catalog.js \
      --input /tmp/bundled-models.json \
      --output /app/build/restricted-models.json \
      ${HUGH_MODEL_SLUG:+--slug ${HUGH_MODEL_SLUG}} \
 && rm -f /tmp/bundled-models.json

# Шаг 2. Доказательство изоляции на настоящем бинаре с локальным mock-провайдером.
# Конфигурация ровно та же, что в проде, кроме блока провайдера и способа авторизации.
# Непройденная проверка останавливает сборку — предохранитель /reply не открывается.
RUN node test-support/run-isolation-check.js \
      --binary /usr/local/bin/codex \
      --catalog /app/build/restricted-models.json \
      --proof /app/build/tool-isolation-proof.json

# Каталог и доказательство делаем неизменяемыми для рабочего пользователя.
USER root
RUN chown -R root:root /app/build \
 && chmod 0555 /app/build \
 && chmod 0444 /app/build/restricted-models.json /app/build/tool-isolation-proof.json

ENV NODE_ENV=production \
    PORT=8080 \
    CODEX_HOME=/data/codex \
    HUGH_WORKSPACE=/workspace \
    HUGH_CODEX_BINARY=/usr/local/bin/codex \
    DATABASE_PATH=/data/state/hugh-runtime.sqlite \
    HUGH_MODEL_CATALOG_PATH=/app/build/restricted-models.json \
    HUGH_PROOF_PATH=/app/build/tool-isolation-proof.json \
    HOME=/tmp

USER hugh
EXPOSE 8080
CMD ["node", "server.js"]
