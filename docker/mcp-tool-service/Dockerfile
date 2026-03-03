FROM node:20-alpine

WORKDIR /app
COPY server.mjs /app/server.mjs

ENV NODE_ENV=production
ENV PORT=8004

EXPOSE 8004
CMD ["node", "/app/server.mjs"]
