ARG NODE_IMAGE=node:24.22.1-bookworm-slim
FROM ${NODE_IMAGE} AS node-runtime
FROM node-runtime AS build
WORKDIR /work
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/
COPY apps/ui/package.json apps/ui/
COPY packages/api-schema/package.json packages/api-schema/
RUN npm ci --no-audit --no-fund
COPY . .
ARG STV_BUILD_VERSION=
RUN STV_BUILD_VERSION="$STV_BUILD_VERSION" node scripts/build-release.mjs --no-workspace-links

# Copy the pinned PostgreSQL distribution without inheriting its anonymous
# volume, root entrypoint or unused LLVM JIT runtime.
FROM postgres:18-bookworm@sha256:ece55f7868da684e400f82f1030a050718adbdd65c23aa500c486f6e2950dc0f AS postgres-assets
RUN mkdir -p /out/usr/lib/postgresql /out/usr/share/postgresql /out/usr/share/doc \
    && cp -a /usr/lib/postgresql/18 /out/usr/lib/postgresql/ \
    && rm -rf /out/usr/lib/postgresql/18/lib/bitcode /out/usr/lib/postgresql/18/lib/llvmjit.so /out/usr/lib/postgresql/18/lib/llvmjit_types.bc \
    && cp -a /usr/share/postgresql/18 /out/usr/share/postgresql/ \
    && cp -L /usr/share/postgresql/18/postgresql.conf.sample /out/usr/share/postgresql/postgresql.conf.sample \
    && cp -a /usr/share/zoneinfo /out/usr/share/ \
    && find /usr/lib -maxdepth 3 -name 'libpq.so.5*' -exec cp -a --parents '{}' /out/ ';' \
    && cp -a /usr/share/doc/postgresql-18 /usr/share/doc/postgresql-client-18 /out/usr/share/doc/ \
    && find /usr/share/doc -name copyright -type f -exec cp --parents '{}' /out/ ';'

# Build only the local MP4 -> JPEG and JPEG verification pipeline. Recording and
# HLS transport are implemented by Node; no device/network stack is needed here.
FROM ${NODE_IMAGE} AS media-build
RUN sed -i 's/^Types: deb$/Types: deb deb-src/' /etc/apt/sources.list.d/debian.sources \
    && apt-get update && apt-get install -y --no-install-recommends build-essential nasm pkg-config libdav1d-dev \
    && mkdir /source && cd /source && apt-get source ffmpeg
COPY deploy/build-ffmpeg.sh /build-ffmpeg.sh
RUN sh /build-ffmpeg.sh

FROM debian:bookworm-slim AS postgres-system
RUN apt-get update && apt-get install -y --no-install-recommends \
      libstdc++6 libdav1d6 ca-certificates libzstd1 liblz4-1 libxml2 libpam0g libssl3 \
      libgssapi-krb5-2 zlib1g libnuma1 libldap-2.5-0 libicu72 liburing2 libsystemd0 libnss-wrapper util-linux \
    && mkdir -p /usr/local/lib \
    && wrapper="$(find /usr/lib -name libnss_wrapper.so -type f -print -quit)" \
    && test -n "$wrapper" && ln -s "$wrapper" /usr/local/lib/libnss_wrapper.so \
    && rm -rf /var/lib/apt/lists/*
COPY --from=postgres-assets /out/ /
COPY --from=node-runtime /usr/local/bin/node /usr/local/bin/node
COPY --from=node-runtime /usr/local/LICENSE /usr/local/share/doc/node/LICENSE
ENV STV_POSTGRES_BIN=/usr/lib/postgresql/18/bin PATH=/usr/lib/postgresql/18/bin:$PATH

FROM postgres-system AS runtime-base
ARG STV_BUILD_REVISION=
ARG STV_SOURCE_URL=
LABEL org.opencontainers.image.title="ST-Vault" org.opencontainers.image.licenses="Apache-2.0" io.st-vault.component="app"
LABEL org.opencontainers.image.revision="${STV_BUILD_REVISION}" org.opencontainers.image.source="${STV_SOURCE_URL}"
ENV NODE_ENV=production STV_DATA_DIR=/data STV_MEDIA_DIR=/media STV_PORT=10002 STV_HOST=0.0.0.0 HOME=/tmp
ENV STV_BUILD_REVISION=${STV_BUILD_REVISION}
ENV TZ=Asia/Shanghai
WORKDIR /app
COPY package.json package-lock.json LICENSE ./
COPY docs/third-party.en.md ./THIRD_PARTY.md
COPY licenses/ ./licenses/
COPY apps/server/package.json apps/server/
COPY packages/api-schema/package.json packages/api-schema/
# npm is a build tool, not a runtime dependency.
FROM build AS production-deps
RUN npm ci --omit=dev --ignore-scripts --workspace @st-vault/server --workspace @st-vault/api-schema --no-audit --no-fund

FROM runtime-base AS runtime
COPY --from=production-deps /work/node_modules/ ./node_modules/
COPY --from=production-deps /work/apps/server/node_modules/ ./apps/server/node_modules/
COPY --from=production-deps /work/packages/api-schema/node_modules/ ./packages/api-schema/node_modules/
COPY --from=media-build /out/ /usr/local/
COPY --from=build /work/build/ ./
EXPOSE 10002
CMD ["node", "apps/server/src/deploy/start.js"]

FROM postgres-system AS browserbase
RUN apt-get update && apt-get install -y --no-install-recommends chromium fonts-liberation fonts-noto-cjk ffmpeg \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 1000 stvault && useradd --uid 1000 --gid 1000 --home-dir /tmp stvault
COPY --from=node-runtime /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx

# QA owns a temporary, container-local PostgreSQL instance for all unit/browser
# tests. No database service or QA dependency enters the production container.
FROM browserbase AS qa
WORKDIR /work
COPY --from=build --chown=1000:1000 /work/ ./
RUN chown 1000:1000 /work
ENV STV_QA_BROWSER_EXECUTABLE=/usr/bin/chromium STV_QA_FFMPEG=ffmpeg STV_TEST_POSTGRES=1 HOME=/tmp
USER 1000:1000
ENTRYPOINT ["node", "scripts/run-with-postgres.mjs"]
CMD ["npm", "run", "test:browser"]

FROM qa AS postgres-qa
CMD ["npm", "test", "--workspace", "@st-vault/server", "--", "src/database"]
