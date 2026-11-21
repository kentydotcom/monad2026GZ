FROM node:22-bookworm-slim AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM node:22-bookworm-slim
WORKDIR /app/store
COPY store/package.json store/package-lock.json ./
RUN npm ci --omit=dev
COPY store/src ./src
COPY store/tsconfig.json ./tsconfig.json
COPY --from=web /web/dist /app/web/dist
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=8787
ENV DATA_DIR=/data
ENV STATIC_DIR=/app/web/dist
ENV RPC_URL=https://testnet-rpc.monad.xyz
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:8787/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["npm", "start", "--silent"]
