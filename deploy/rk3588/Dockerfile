FROM node:22.19.0-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production

COPY --chown=10001:10001 package.json ./
COPY --chown=10001:10001 src ./src

USER 10001:10001

EXPOSE 47930

CMD ["node", "src/launcher.js", "--mode", "rk3588"]
