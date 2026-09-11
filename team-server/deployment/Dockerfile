FROM node:24-bookworm-slim

WORKDIR /app
COPY package.json tsconfig.json ./
COPY src ./src

RUN mkdir -p /data /backups && chown -R node:node /app /data /backups

USER node
ENV PAPER_AGENT_TEAM_HOST=0.0.0.0 PAPER_AGENT_TEAM_PORT=14713
EXPOSE 14713
CMD ["node", "src/index.ts"]
