FROM node:24-alpine

WORKDIR /app
COPY server.js ./server.js
COPY quiet-hours.js ./quiet-hours.js
COPY task-intake.js ./task-intake.js

EXPOSE 8080
CMD ["node", "server.js"]
