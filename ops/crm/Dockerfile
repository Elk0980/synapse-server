FROM node:24-alpine

WORKDIR /app
COPY package*.json ./
# Точные версии и транзитивные зависимости — из package-lock.json (ревью PR 496, №95 комм. 480).
RUN npm ci --omit=dev
COPY *.js ./
COPY studio-content-plan-data.json ./

EXPOSE 8080
CMD ["node", "server.js"]
