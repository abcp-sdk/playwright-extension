# syntax=docker/dockerfile:1
# The extension drives a REMOTE browser over CDP, so no Chromium is bundled or
# downloaded (PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD). The build runs esbuild so the
# runtime image needs no transpiler: `@abc-protocol/sdk` is a git dependency
# that ships raw `.ts`, which the container's Node cannot execute directly.
ARG REGISTRY=docker.io
FROM ${REGISTRY}/root/node:26-alpine AS build
ARG HTTP_PROXY
ARG HTTPS_PROXY
ENV HTTP_PROXY=${HTTP_PROXY} \
    HTTPS_PROXY=${HTTPS_PROXY} \
    NO_PROXY=localhost,127.0.0.1,.svc.cluster.local,.svc \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
WORKDIR /build
# git fetches the public `github:` git dependencies (the SDK ships raw TS and
# is not on a registry); the https rewrite means no SSH key is needed.
RUN apk add --no-cache git \
    && git config --global url."https://github.com/".insteadOf "ssh://git@github.com/" \
    && git config --global url."https://github.com/".insteadOf "git+ssh://git@github.com/"
COPY package.json package-lock.json .npmrc tsconfig.json ./
COPY scripts scripts
COPY src src
RUN npm install --no-audit --strict-ssl=false && npm run build

FROM ${REGISTRY}/root/alpine:3.24
RUN sed -i 's|dl-cdn.alpinelinux.org|mirrors.aliyun.com|g' /etc/apk/repositories \
    && apk add --no-cache ca-certificates nodejs
WORKDIR /app
# playwright-core is external (a real package resolved at runtime); everything
# else is inlined into dist/main.js.
COPY --from=build /build/node_modules/playwright-core node_modules/playwright-core
COPY --from=build /build/dist/main.js dist/main.js
COPY --from=build /build/package.json package.json
EXPOSE 8080
CMD ["node", "dist/main.js"]
