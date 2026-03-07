FROM node:20-alpine

# Install ffmpeg for video thumbnail generation
RUN apk add --no-cache ffmpeg

WORKDIR /app

# Install dependencies (production only)
COPY package*.json ./
RUN npm ci --only=production && npm cache clean --force

# Copy application files
COPY server.js ./
COPY server/ ./server/
COPY public/ ./public/

# Non-root user for security
RUN addgroup -S gmm && adduser -S gmm -G gmm
USER gmm

EXPOSE 3334

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s \
  CMD wget -qO- http://localhost:3334/api/health || exit 1

CMD ["node", "server.js"]
