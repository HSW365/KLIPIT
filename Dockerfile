FROM node:20-slim

# ffmpeg + fonts for rendering, python + yt-dlp for stream reading/segment download
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg python3 python3-pip fonts-dejavu ca-certificates \
  && pip3 install --no-cache-dir --break-system-packages -U yt-dlp \
  && apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY . .

ENV PORT=3000
EXPOSE 3000
CMD ["node", "server/server.js"]
