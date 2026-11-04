FROM node:latest
WORKDIR /app
RUN apt-get update
RUN apt-get install -y git
COPY . .
RUN npm ci
CMD ["node", "server.js"]
