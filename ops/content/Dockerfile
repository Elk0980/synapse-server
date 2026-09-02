FROM node:24-alpine

WORKDIR /app
COPY server.js ./server.js
COPY seed ./seed

EXPOSE 8080
CMD ["node", "server.js"]
