FROM node:24-alpine

WORKDIR /app
COPY *.js ./
COPY seed ./seed

EXPOSE 8080
CMD ["node", "server.js"]
