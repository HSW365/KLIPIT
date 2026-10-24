FROM node:22-slim

# ffmpeg + fonts for rendering, yt-dlp for reading streams, faster-whisper for free local speech-to-text
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg python3 python3-pip fonts-dejavu ca-certificates \
  && pip3 install --no-cache-dir --break-system-packages -U yt-dlp faster-whisper \
  && python3 -c "from faster_whisper import WhisperModel; WhisperModel('tiny.en', device='cpu', compute_type='int8', download_root='/opt/whisper')" \
  && apt-get clean && rm -rf /var/lib/apt/lists/* /root/.cache

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY . .

ENV PORT=3000 WHISPER_DIR=/opt/whisper
EXPOSE 3000
CMD ["node", "server/server.js"]
