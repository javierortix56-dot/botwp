FROM node:18-bullseye-slim

RUN apt-get update && apt-get install -y \
    python3 make g++ curl \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY . .

CMD ["node", "index.js"]
