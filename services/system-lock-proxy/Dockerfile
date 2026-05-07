FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY src ./src
ENV LISTEN_PORT=8080
EXPOSE 8080
USER node
CMD ["node", "src/index.js"]
