# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e

ARG NODE_IMAGE=node:24.20.0-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e
ARG TOOLCHAIN_SOURCE=toolchain-bootstrap

FROM ${NODE_IMAGE} AS toolchain-bootstrap

ENV PNPM_HOME=/pnpm
ENV PATH=/pnpm:$PATH
ENV CI=true

RUN corepack enable
RUN corepack prepare pnpm@11.11.0 --activate
RUN test "$(pnpm --version)" = "11.11.0"

WORKDIR /workspace

# Copy only manifests first so the frozen dependency layer is cacheable.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/api/package.json apps/api/tsconfig.json apps/api/tsconfig.build.json ./apps/api/
COPY apps/web/package.json apps/web/tsconfig.json ./apps/web/
COPY apps/worker/package.json apps/worker/tsconfig.json ./apps/worker/
COPY apps/operator-cli/package.json apps/operator-cli/tsconfig.json apps/operator-cli/tsconfig.build.json ./apps/operator-cli/
COPY apps/retention-cli/package.json apps/retention-cli/tsconfig.json apps/retention-cli/tsconfig.build.json ./apps/retention-cli/
COPY apps/migrator/package.json ./apps/migrator/
COPY packages/db/package.json packages/db/tsconfig.json ./packages/db/
COPY packages/neis/package.json packages/neis/tsconfig.json ./packages/neis/
COPY packages/api-client/package.json packages/api-client/tsconfig.json ./packages/api-client/

RUN --mount=type=cache,id=classhub-pnpm,target=/pnpm/store \
    pnpm fetch --store-dir=/pnpm/store && \
    pnpm install --frozen-lockfile --offline --store-dir=/pnpm/store && \
    pnpm --filter @classhub/api deploy --prod --legacy \
      --store-dir=/pnpm/store /tmp/classhub-deploy-prime/api && \
    pnpm --filter @classhub/worker deploy --prod --legacy \
      --store-dir=/pnpm/store /tmp/classhub-deploy-prime/worker && \
    pnpm --filter @classhub/retention-cli deploy --prod --legacy \
      --store-dir=/pnpm/store /tmp/classhub-deploy-prime/retention && \
    pnpm --filter @classhub/migrator deploy --prod --legacy \
      --store-dir=/pnpm/store /tmp/classhub-deploy-prime/migrator && \
    pnpm install --frozen-lockfile --offline --store-dir=/pnpm/store && \
    rm -rf /tmp/classhub-deploy-prime && \
    cp -a /pnpm/store /pnpm/hermetic-store && \
    sha256sum \
      apps/api/package.json \
      apps/migrator/package.json \
      apps/operator-cli/package.json \
      apps/retention-cli/package.json \
      apps/web/package.json \
      apps/worker/package.json \
      package.json \
      packages/api-client/package.json \
      packages/db/package.json \
      packages/neis/package.json \
      pnpm-lock.yaml \
      pnpm-workspace.yaml \
      > /pnpm/hermetic-dependency-inputs.sha256

COPY scripts/prune-runtime-artifacts.mjs ./scripts/prune-runtime-artifacts.mjs
COPY scripts/prune-production-dependency-artifacts.mjs ./scripts/prune-production-dependency-artifacts.mjs

# Release verification may replace this stage with a digest-pinned toolchain
# image built from the same frozen lockfile. The default keeps normal builds
# on the existing online bootstrap path.
FROM ${TOOLCHAIN_SOURCE} AS toolchain

ARG SOURCE_DATE_EPOCH=0

# Fail closed before build or deploy when an injected toolchain was produced
# from dependency inputs other than the current build context.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml /tmp/hermetic-dependency-inputs/
COPY apps/api/package.json /tmp/hermetic-dependency-inputs/apps/api/
COPY apps/migrator/package.json /tmp/hermetic-dependency-inputs/apps/migrator/
COPY apps/operator-cli/package.json /tmp/hermetic-dependency-inputs/apps/operator-cli/
COPY apps/retention-cli/package.json /tmp/hermetic-dependency-inputs/apps/retention-cli/
COPY apps/web/package.json /tmp/hermetic-dependency-inputs/apps/web/
COPY apps/worker/package.json /tmp/hermetic-dependency-inputs/apps/worker/
COPY packages/api-client/package.json /tmp/hermetic-dependency-inputs/packages/api-client/
COPY packages/db/package.json /tmp/hermetic-dependency-inputs/packages/db/
COPY packages/neis/package.json /tmp/hermetic-dependency-inputs/packages/neis/

RUN cd /tmp/hermetic-dependency-inputs && \
    sha256sum -c /pnpm/hermetic-dependency-inputs.sha256 && \
    dependency_input_sha256="$(sha256sum /pnpm/hermetic-dependency-inputs.sha256 | cut -d ' ' -f 1)" && \
    cp -a . /workspace/ && \
    cd /workspace && \
    pnpm install --frozen-lockfile --offline --ignore-scripts \
      --store-dir=/pnpm/hermetic-store && \
    printf 'validated_pnpm_input_manifest_sha256=%s\n' "$dependency_input_sha256"

# Keep build configuration and normalization scripts sourced from the current
# context even when release verification injects a prebuilt toolchain image.
COPY tsconfig.base.json ./tsconfig.base.json
COPY scripts/prune-runtime-artifacts.mjs ./scripts/prune-runtime-artifacts.mjs
COPY scripts/prune-production-dependency-artifacts.mjs ./scripts/prune-production-dependency-artifacts.mjs

FROM toolchain AS api-build

COPY apps ./apps
COPY packages ./packages
COPY scripts/build-web-deployment.mjs scripts/project-records.mjs ./scripts/
COPY OPERATIONS/project-records/store.mjs ./OPERATIONS/project-records/store.mjs
COPY data/project-records.sqlite ./data/project-records.sqlite

RUN pnpm --filter @classhub/db build
RUN pnpm --filter @classhub/api-client build
RUN pnpm --filter @classhub/api build
RUN pnpm --filter @classhub/web build

# deploy creates self-contained, lock-derived dependency trees. The runtime
# stages below still copy only package.json, dist, and production node_modules.
RUN pnpm --filter @classhub/api deploy --prod --legacy --offline \
    --store-dir=/pnpm/hermetic-store /out/api
RUN node scripts/prune-runtime-artifacts.mjs \
    /workspace/apps/api/dist \
    /out/api/node_modules/@classhub/db/dist \
    /out/api/node_modules/@classhub/neis/dist
RUN node scripts/prune-production-dependency-artifacts.mjs /out/api/node_modules

FROM toolchain AS worker-build

COPY apps ./apps
COPY packages ./packages

RUN pnpm --filter @classhub/db build
RUN pnpm --filter @classhub/worker build
RUN pnpm --filter @classhub/worker deploy --prod --legacy --offline \
    --store-dir=/pnpm/hermetic-store /out/worker
RUN node scripts/prune-runtime-artifacts.mjs \
    /workspace/apps/worker/dist \
    /out/worker/node_modules/@classhub/db/dist
RUN node scripts/prune-production-dependency-artifacts.mjs /out/worker/node_modules

FROM toolchain AS retention-build

COPY apps ./apps
COPY packages ./packages

RUN pnpm --filter @classhub/db build
RUN pnpm --filter @classhub/retention-cli build
RUN pnpm --filter @classhub/retention-cli deploy --prod --legacy --offline \
    --store-dir=/pnpm/hermetic-store /out/retention
RUN node scripts/prune-runtime-artifacts.mjs \
    /workspace/apps/retention-cli/dist \
    /out/retention/node_modules/@classhub/db/dist
RUN node scripts/prune-production-dependency-artifacts.mjs /out/retention/node_modules

FROM toolchain AS operator-build

COPY apps ./apps
COPY packages ./packages

RUN pnpm --filter @classhub/db build
# operator-cli의 build 스크립트가 @classhub/neis도 함께 빌드한다.
RUN pnpm --filter @classhub/operator-cli build
RUN pnpm --filter @classhub/operator-cli deploy --prod --legacy --offline \
    --store-dir=/pnpm/hermetic-store /out/operator
RUN node scripts/prune-runtime-artifacts.mjs \
    /workspace/apps/operator-cli/dist \
    /out/operator/node_modules/@classhub/db/dist \
    /out/operator/node_modules/@classhub/neis/dist
RUN node scripts/prune-production-dependency-artifacts.mjs /out/operator/node_modules

FROM toolchain AS migrator-build

COPY apps/migrator ./apps/migrator
COPY packages/db ./packages/db

RUN pnpm --filter @classhub/db build
RUN pnpm --filter @classhub/migrator deploy --prod --legacy --offline \
    --store-dir=/pnpm/hermetic-store /out/migrator
RUN node scripts/prune-runtime-artifacts.mjs /out/migrator/node_modules/@classhub/db/dist
RUN node scripts/prune-production-dependency-artifacts.mjs /out/migrator/node_modules

FROM ${NODE_IMAGE} AS api

ARG SOURCE_REVISION=unknown
LABEL org.opencontainers.image.title="우리반 허브 학생·교사 API + Web" \
      org.opencontainers.image.source="local-workspace" \
      org.opencontainers.image.revision=$SOURCE_REVISION

# 학생·교사 프로그램(T-ADMIN-SPLIT): 관리자 기능·관리자 비밀값 없이 Web/만 내준다.
ENV NODE_ENV=production \
    API_SURFACE=user \
    API_HOST=0.0.0.0 \
    API_PORT=3000 \
    SERVE_WEB=true \
    ADMIN_WEB_ENABLED=false \
    LOCAL_TEST_ADMIN_ENABLED=false

WORKDIR /app/apps/api

COPY --from=api-build /out/api/package.json ./package.json
COPY --from=api-build /out/api/node_modules ./node_modules
COPY --from=api-build /workspace/apps/api/dist ./dist
COPY --from=api-build /workspace/.local-runtime/qa-web-production /app/Web
COPY THIRD_PARTY_NOTICES.json THIRD_PARTY_NOTICES.md /app/licenses/
COPY THIRD_PARTY_LICENSES /app/licenses/THIRD_PARTY_LICENSES

USER node
EXPOSE 3000
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "-e", "const port=process.env.API_PORT??'3000';fetch(`http://127.0.0.1:${port}/healthz`,{signal:AbortSignal.timeout(2000)}).then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["node", "dist/main.js"]

FROM ${NODE_IMAGE} AS api-admin

ARG SOURCE_REVISION=unknown
LABEL org.opencontainers.image.title="우리반 허브 관리자 API + AdminWeb" \
      org.opencontainers.image.source="local-workspace" \
      org.opencontainers.image.revision=$SOURCE_REVISION

# 관리자 프로그램(T-ADMIN-SPLIT): /api/v1/admin·약관 읽기·화면 오류 기록만 받고 AdminWeb/을 내준다.
# ADMIN_WEB_ENABLED·관리자 비밀값·USER_APP_ORIGIN은 실행 설정에서 넣는다(운영 모드는 학생·교사와 다른 관리자 주소에서만 기동, 4단계 승인 2026-10-08).
ENV NODE_ENV=production \
    API_SURFACE=admin \
    API_HOST=0.0.0.0 \
    API_PORT=3002 \
    SERVE_WEB=true \
    LOCAL_TEST_ADMIN_ENABLED=false

WORKDIR /app/apps/api

COPY --from=api-build /out/api/package.json ./package.json
COPY --from=api-build /out/api/node_modules ./node_modules
COPY --from=api-build /workspace/apps/api/dist ./dist
COPY --from=api-build /workspace/.local-runtime/qa-admin-web /app/AdminWeb
COPY THIRD_PARTY_NOTICES.json THIRD_PARTY_NOTICES.md /app/licenses/
COPY THIRD_PARTY_LICENSES /app/licenses/THIRD_PARTY_LICENSES

USER node
EXPOSE 3002
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "-e", "const port=process.env.API_PORT??'3002';fetch(`http://127.0.0.1:${port}/healthz`,{signal:AbortSignal.timeout(2000)}).then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["node", "dist/main.js"]

FROM ${NODE_IMAGE} AS worker

ARG SOURCE_REVISION=unknown
LABEL org.opencontainers.image.title="우리반 허브 Worker" \
      org.opencontainers.image.source="local-workspace" \
      org.opencontainers.image.revision=$SOURCE_REVISION

ENV NODE_ENV=production \
    WORKER_HEALTH_HOST=0.0.0.0 \
    WORKER_HEALTH_PORT=3001
WORKDIR /app/apps/worker

COPY --from=worker-build /out/worker/package.json ./package.json
COPY --from=worker-build /out/worker/node_modules ./node_modules
COPY --from=worker-build /workspace/apps/worker/dist ./dist
COPY THIRD_PARTY_NOTICES.json THIRD_PARTY_NOTICES.md /app/licenses/
COPY THIRD_PARTY_LICENSES /app/licenses/THIRD_PARTY_LICENSES

USER node
EXPOSE 3001
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "-e", "const port=process.env.WORKER_HEALTH_PORT??'3001';fetch(`http://127.0.0.1:${port}/healthz`,{signal:AbortSignal.timeout(2000)}).then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["node", "dist/main.js"]

FROM ${NODE_IMAGE} AS migrator

ARG SOURCE_REVISION=unknown
LABEL org.opencontainers.image.title="우리반 허브 DB Migrator" \
      org.opencontainers.image.source="local-workspace" \
      org.opencontainers.image.revision=$SOURCE_REVISION

ENV NODE_ENV=production
WORKDIR /app

COPY --from=migrator-build /out/migrator/package.json ./package.json
COPY --from=migrator-build /out/migrator/run-migrations.mjs ./run-migrations.mjs
COPY --from=migrator-build /out/migrator/node_modules ./node_modules
COPY db/migrations ./db/migrations
COPY THIRD_PARTY_NOTICES.json THIRD_PARTY_NOTICES.md /app/licenses/
COPY THIRD_PARTY_LICENSES /app/licenses/THIRD_PARTY_LICENSES

USER node
STOPSIGNAL SIGTERM
ENTRYPOINT ["node", "run-migrations.mjs"]
CMD ["up"]

FROM ${NODE_IMAGE} AS operator

ARG SOURCE_REVISION=unknown
LABEL org.opencontainers.image.title="우리반 허브 Operator CLI" \
      org.opencontainers.image.source="local-workspace" \
      org.opencontainers.image.revision=$SOURCE_REVISION

ENV NODE_ENV=production
WORKDIR /app/apps/operator-cli

COPY --from=operator-build /out/operator/package.json ./package.json
COPY --from=operator-build /out/operator/node_modules ./node_modules
COPY --from=operator-build /workspace/apps/operator-cli/dist ./dist
COPY THIRD_PARTY_NOTICES.json THIRD_PARTY_NOTICES.md /app/licenses/
COPY THIRD_PARTY_LICENSES /app/licenses/THIRD_PARTY_LICENSES

USER node
STOPSIGNAL SIGTERM
ENTRYPOINT ["node", "dist/main.js"]
CMD ["--help"]

FROM ${NODE_IMAGE} AS retention

ARG SOURCE_REVISION=unknown
LABEL org.opencontainers.image.title="우리반 허브 Retention Job" \
      org.opencontainers.image.source="local-workspace" \
      org.opencontainers.image.revision=$SOURCE_REVISION

ENV NODE_ENV=production
WORKDIR /app/apps/retention-cli

COPY --from=retention-build /out/retention/package.json ./package.json
COPY --from=retention-build /out/retention/node_modules ./node_modules
COPY --from=retention-build /workspace/apps/retention-cli/dist ./dist
COPY THIRD_PARTY_NOTICES.json THIRD_PARTY_NOTICES.md /app/licenses/
COPY THIRD_PARTY_LICENSES /app/licenses/THIRD_PARTY_LICENSES

USER node
STOPSIGNAL SIGTERM
# 단발성 job이다. 스케줄러가 주기마다 새로 띄우며, 인자로 대상과 모드를 준다.
# 기본값을 --execute로 두지 않는다 — 인자 없이 뜬 컨테이너가 곧바로 삭제를
# 시작하면 안 된다. 대상 기본값도 평가 기록이므로 모드만 빠져도 위험하다.
ENTRYPOINT ["node", "dist/main.js"]
CMD ["--dry-run"]
