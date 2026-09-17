# Приватный рантайм Hugh. Образ на glibc (bookworm-slim), потому что официальные сборки
# @openai/codex распространяются для gnu-целей; alpine здесь не используется намеренно.
FROM node:24-bookworm-slim

ARG CODEX_VERSION=0.154.0
ARG NPM_REGISTRY=https://registry.npmjs.org/
# Пусто — выбирается первый согласованный слаг из встроенного набора (см. model-catalog.js).
ARG HUGH_MODEL_SLUG=

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

RUN useradd --uid 10001 --create-home --shell /usr/sbin/nologin hugh \
 && mkdir -p /workspace /data /app/build \
 && chown -R hugh:hugh /workspace /data /app/build \
 && chmod 0755 /workspace

USER hugh

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
