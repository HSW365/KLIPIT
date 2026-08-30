# KLIPIT runtime: Node + ffmpeg + yt-dlp.
FROM node:20-slim

# ffmpeg (cut/analyze) + yt-dlp (download VODs). python3 is needed for yt-dlp.
RUN apt-get update && \
    apt-get install -y --no-install-recommends ffmpeg python3 python3-pip ca-certificates && \
    pip3 install --no-cache-dir --break-system-packages yt-dlp && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY . .

# clips + working files live here; mount a persistent disk at /data on your host
ENV DATA_DIR=/data
RUN mkdir -p /data

ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.js"]
