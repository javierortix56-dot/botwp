FROM node:20-bullseye-slim

RUN apt-get update && apt-get install -y \
    python3 make g++ curl git ca-certificates \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

RUN git config --global url."https://github.com/".insteadOf ssh://git@github.com/

COPY package.json ./
RUN npm install --omit=dev

COPY . .

CMD ["node", "index.js"]
