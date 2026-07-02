# Tideholm — zero-dependency Node, so the image is tiny.
FROM node:22-alpine
WORKDIR /app
COPY game.js bots.js server.js ./
COPY public ./public
VOLUME /app/data
ENV PORT=3000
EXPOSE 3000
CMD ["node", "server.js"]
