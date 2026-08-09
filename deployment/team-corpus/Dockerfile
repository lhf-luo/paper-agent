FROM node:22.19.0-bookworm-slim

WORKDIR /app
COPY src ./src
COPY scripts/team-corpus-server.ts ./scripts/team-corpus-server.ts

RUN mkdir -p /data /backups && chown -R node:node /app /data /backups

USER node
ENV PAPER_AGENT_TEAM_HOST=0.0.0.0 PAPER_AGENT_TEAM_PORT=4317
EXPOSE 4317
CMD ["node", "scripts/team-corpus-server.ts"]
