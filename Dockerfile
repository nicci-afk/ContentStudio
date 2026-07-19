FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY . .
EXPOSE 4600
VOLUME /app/data
CMD ["node", "server.js"]
