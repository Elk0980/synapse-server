FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY server.js documents.js tools.js seed.js ./
USER node
EXPOSE 8080
CMD ["node", "server.js"]
