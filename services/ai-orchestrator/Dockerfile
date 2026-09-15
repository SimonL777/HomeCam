FROM node:22-alpine

RUN apk add --no-cache su-exec \
    && mkdir -p /var/lib/homecam-ai \
    && chown -R node:node /var/lib/homecam-ai

WORKDIR /app
COPY package.json ./
COPY src ./src
COPY scripts ./scripts
COPY --chmod=0755 docker-entrypoint.sh /usr/local/bin/homecam-ai-entrypoint

EXPOSE 8090
ENTRYPOINT ["homecam-ai-entrypoint"]
CMD ["node", "src/server.js"]
