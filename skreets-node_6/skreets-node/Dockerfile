FROM node:20-alpine
WORKDIR /app
COPY . .
ENV NODE_ENV=production PORT=3000 DATA_DIR=/data
RUN mkdir -p /data && chown node:node /data \
 && SERVER="$(find /app -name server.js -not -path '*/node_modules/*' | head -n 1)" \
 && if [ -z "$SERVER" ]; then echo "server.js was not found in the repo. Upload it to GitHub and redeploy." && exit 1; fi \
 && echo "Using $SERVER" && ln -s "$(dirname "$SERVER")" /game
USER node
WORKDIR /game
EXPOSE 3000
CMD ["node", "server.js"]
