FROM node:20-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --production

COPY server.js ./
COPY public/ ./public/

# DB ve data dizinleri
RUN mkdir -p /data /db

ENV PORT=3737
ENV DB_PATH=/db/kanban.db
ENV PLUGINS_DIR=/data/plugins
ENV CRON_SCHEDULE="0 8 * * *"

EXPOSE 3737

CMD ["node", "server.js"]
