FROM node:18-slim

RUN apt-get update && apt-get install -y \
    python3 make g++ \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY . .

CMD ["node", "index.js"]
