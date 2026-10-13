FROM node:20-alpine

WORKDIR /app

# Dependencies eerst, zodat deze layer gecached blijft bij codewijzigingen.
# Let op: er is (nog) geen package-lock.json, dus "npm install" i.p.v. "npm ci".
# Zodra je een lockfile commit, kun je dit vervangen door "npm ci --omit=dev".
COPY package*.json ./
RUN npm install --omit=dev

# Applicatie
COPY . .

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.js"]
