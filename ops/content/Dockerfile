FROM node:24-alpine

WORKDIR /app
COPY *.js ./
COPY seed ./seed
# Доверенный каталог навыков читается только на чтение и только как markdown.
# Без этой строки загрузчик в контейнере не нашёл бы ни одного навыка.
COPY skills ./skills

EXPOSE 8080
CMD ["node", "server.js"]
