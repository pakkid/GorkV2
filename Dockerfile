FROM node:22-slim

ENV NODE_ENV=production \
    DATA_DIR=/app/data
WORKDIR /app

# ffmpeg cuts frames out of gifs so gork sees the whole thing, not just the first frame
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY tsconfig.json ./
COPY src ./src

# settings + stats live here; mount a volume over it
RUN mkdir -p /app/data && chown node:node /app/data
VOLUME /app/data
USER node

CMD ["node", "--disable-warning=ExperimentalWarning", "--import", "tsx", "src/index.ts"]
