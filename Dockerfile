# El modo `--http` de la fase 6. Para stdio no hace falta: lo arranca `npx` en la maquina del
# usuario, que es justo donde tienen que estar sus credenciales.
FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json tsup.config.ts ./
COPY src ./src
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist

# Nunca root: este proceso lleva dentro el client_secret de la app.
USER node
EXPOSE 3000

# El bind a 0.0.0.0 es correcto AQUI y solo aqui: el contenedor es la frontera, y publicar el
# puerto es una decision de quien despliega. Sin PLANVORTEX_MCP_AUTH_TOKEN el proceso se niega a
# arrancar (trampa 12), asi que no hay forma de dejarlo abierto por descuido.
ENTRYPOINT ["node", "dist/index.js", "--http", "--host", "0.0.0.0"]
