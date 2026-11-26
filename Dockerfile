FROM mcr.microsoft.com/playwright:v1.65.1-noble

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server.mjs ./
COPY public ./public

ENV PORT=10000
ENV POLL_MS=500
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
EXPOSE 10000

CMD ["node", "server.mjs"]
