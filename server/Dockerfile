# The collaboration server image.
#
# Two stages so the runtime image carries the built JavaScript and a runtime
# and nothing else: no compiler, no TypeScript, no source tree. A build stage
# left in the shipped image is a larger attack surface for no benefit.
#
# The base is pinned by digest rather than by tag. A tag moves, so an image
# built today and one built next month from the same Dockerfile would not be
# the same image, and a rollback to "the version that worked" would not be one.

FROM node:24.13.0-alpine AS build
WORKDIR /build

# esbuild is the only build-time dependency, and it is pinned exactly. The
# bundle it produces has no runtime dependencies at all: the server uses
# node:http, node:crypto and node:fs and nothing else.
RUN npm install --no-save --no-audit --no-fund esbuild@0.28.2

COPY src ./src
COPY build.mjs ./build.mjs
RUN node build.mjs

FROM node:24.13.0-alpine AS runtime

# Runs as a non-root user. The node image ships one, so no user is created
# here; creating another would only add a uid nothing else knows about.
WORKDIR /app
COPY --from=build /build/dist/server.mjs ./server.mjs

# The vault is a volume. Owned by the runtime user at build time, because a
# container that cannot write its own data directory fails at the first save
# rather than at start-up, which is a much later and much less obvious failure.
RUN mkdir -p /data/documents && chown -R node:node /data
VOLUME ["/data"]

USER node
ENV NODE_ENV=production
ENV PORT=8787
ENV HOST=0.0.0.0
ENV VAULT_ROOT=/data/documents
EXPOSE 8787

# The health check speaks to the real route rather than merely proving the
# process exists. A process that is alive and has stopped serving is the exact
# state a liveness check is for, and `pgrep node` reports it as healthy.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.mjs"]
