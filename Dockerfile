# syntax=docker/dockerfile:1
# The extension drives a REMOTE browser over CDP, so no Chromium is bundled or
# downloaded (PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD) — only playwright-core, the
# abc protocol SDK, and this package's compiled output.
ARG REGISTRY=docker.io
FROM ${REGISTRY}/library/node:26-alpine AS build
ARG HTTP_PROXY
ARG HTTPS_PROXY
ENV HTTP_PROXY=${HTTP_PROXY} \
    HTTPS_PROXY=${HTTPS_PROXY} \
    NO_PROXY=localhost,127.0.0.1,.svc.cluster.local,.svc \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
WORKDIR /build
COPY package.json .npmrc tsconfig.json ./
COPY src src
RUN npm install --no-audit --strict-ssl=false && npm run build

FROM ${REGISTRY}/library/alpine:3.24
RUN sed -i 's|dl-cdn.alpinelinux.org|mirrors.aliyun.com|g' /etc/apk/repositories \
    && apk add --no-cache ca-certificates nodejs
WORKDIR /app
COPY --from=build /build/node_modules node_modules
COPY --from=build /build/dist dist
COPY --from=build /build/package.json package.json
EXPOSE 8080
CMD ["node", "dist/main.js"]
