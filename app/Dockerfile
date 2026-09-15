FROM node:22-alpine

RUN apk add --no-cache ffmpeg su-exec \
    && mkdir -p /var/lib/homecam/config /tmp/homecam-vod \
    && chown -R node:node /var/lib/homecam /tmp/homecam-vod

WORKDIR /app
COPY package.json ./
COPY server.js ./
COPY basic-auth.js ./
COPY ai-proxy.js ./
COPY hls-proxy.js ./
COPY webrtc-proxy.js ./
COPY recording-playback.js ./
COPY public ./public
COPY --chmod=0755 docker-entrypoint.sh /usr/local/bin/homecam-entrypoint

EXPOSE 8080
ENTRYPOINT ["homecam-entrypoint"]
CMD ["node", "server.js"]
