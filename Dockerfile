# syntax=docker/dockerfile:1
# cam-proxy: one image for the cluster (amd64) and the Pi (arm64). go2rtc and
# ffmpeg run as child processes. The container needs a config.json
# (CAMPROXY_CONFIG) whose server.dataDir is the /data volume, and the
# CAMPROXY_* secrets in the environment.
FROM node:26-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
COPY web ./web
RUN npm run build

FROM node:26-alpine
# Links the ghcr package to the repository.
LABEL org.opencontainers.image.source=https://github.com/klaushofrichter/cam-proxy
ARG TARGETARCH
# go2rtc publishes no checksums: these are the SHA-256s pinned in
# scripts/install-go2rtc.sh (keep both in step).
ARG GO2RTC_VERSION=v1.9.14
RUN apk add --no-cache ffmpeg font-dejavu \
 && case "${TARGETARCH:-amd64}" in \
      amd64) a=amd64; sum=32d616af226bd731678ffde328b94cfb94e30339bfefc469cfb76323144615a6 ;; \
      arm64) a=arm64; sum=359fabade8a7a51e81a55fe6df6b0ef81764a5e1d63179577534eaaa71904b50 ;; \
      *) echo "unsupported arch ${TARGETARCH}" >&2; exit 1 ;; \
    esac \
 && wget -q -O /usr/local/bin/go2rtc "https://github.com/AlexxIT/go2rtc/releases/download/${GO2RTC_VERSION}/go2rtc_linux_${a}" \
 && echo "${sum}  /usr/local/bin/go2rtc" | sha256sum -c - \
 && chmod 755 /usr/local/bin/go2rtc \
 && go2rtc -version
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force \
 && node -e "require('sharp')"
COPY --from=build /app/dist ./dist
COPY openapi.yaml CHANGELOG.md config.schema.json ./
RUN mkdir -p /data && chown 1000:1000 /data
ENV NODE_ENV=production CAMPROXY_TARGET=cluster
# Late, so a new version doesn't rebuild the layers above.
ARG APP_VERSION=dev
ARG BUILD_DATE=
ENV CAMPROXY_VERSION=${APP_VERSION} CAMPROXY_BUILD_DATE=${BUILD_DATE}
USER 1000:1000
VOLUME /data
EXPOSE 8480 2121 30000-30009
HEALTHCHECK --interval=15s --timeout=3s --start-period=15s CMD wget -qO- http://127.0.0.1:8480/health >/dev/null || exit 1
CMD ["node", "dist/src/cli.js"]
