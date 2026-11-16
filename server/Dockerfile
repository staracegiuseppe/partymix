# PartyMix server for the NAS. Node runs the TypeScript files directly (type stripping): no build step, no dependencies.
FROM node:24-alpine
ENV NODE_ENV=production PARTYMIX_ROOT=/PartyMix PORT=8788
WORKDIR /app
COPY shared/ ./shared/
COPY server/package.json ./server/
COPY server/src/ ./server/src/
WORKDIR /app/server
USER node
EXPOSE 8788
HEALTHCHECK --interval=60s --timeout=5s CMD wget -qO- http://127.0.0.1:8788/api/health || exit 1
CMD ["node", "--disable-warning=ExperimentalWarning", "src/main.ts"]
