# Воркер автомонтажа Хью (specs/214-auto-montage). Контекст сборки — корень репозитория
# (нужен общий разбор сценария sites/synapse/cabinet/shooting-script.js); лишнее отсекает Dockerfile.dockerignore.
FROM node:24-alpine
RUN apk add --no-cache ffmpeg font-dejavu
WORKDIR /app
COPY ops/montage/package.json ./
COPY ops/montage/render.js ops/montage/draft.js ops/montage/worker.js ./
COPY sites/synapse/cabinet/shooting-script.js ./shooting-script.js
# Том /work создаётся с владельцем node, чтобы непривилегированный процесс мог в него писать.
RUN mkdir -p /work && chown node:node /work
USER node
CMD ["node", "worker.js"]
