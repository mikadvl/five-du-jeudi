FROM node:22-alpine

ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=3000 \
    TZ=Europe/Paris

RUN apk add --no-cache tzdata

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY public ./public
COPY scripts ./scripts

RUN mkdir -p /data && chown node:node /data
VOLUME /data
EXPOSE 3000

USER node
HEALTHCHECK --interval=60s --timeout=5s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1

CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.js"]
