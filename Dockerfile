FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production
ENV DATA_DIR=/app/data

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

VOLUME ["/app/data"]
EXPOSE 46110 46111

CMD ["node", "server.js"]
