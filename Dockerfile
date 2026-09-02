# La imagen habla **stdio por defecto**, y eso no es una preferencia: es lo que hace un cliente MCP
# con un contenedor (`docker run -i`) y es lo que hacen los directorios —Glama, Smithery— cuando
# construyen este fichero, levantan la imagen sin ninguna variable de entorno y le piden
# `tools/list`. Una imagen que arranca en `--http` no contesta a eso y la ficha sale rota.
#
# El modo `--http` de la fase 6 sigue estando, un argumento por detras de la imagen:
#   docker run --rm -p 127.0.0.1:3000:3000 -e ... planvortex-mcp --http --host 0.0.0.0
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

# `dist/cli.js` y NO `dist/index.js`. Son dos ficheros a proposito y este es exactamente el fallo
# que esa separacion avisa que existe: `index.js` solo EXPORTA —no arranca nada—, asi que la
# imagen terminaba con codigo 0, en silencio y sin haber servido nunca nada. El `bin` es `cli.js`.
#
# El bind a 0.0.0.0 del `--http` es correcto en un contenedor y solo ahi: el contenedor es la
# frontera, y publicar el puerto es una decision de quien despliega. Sin PLANVORTEX_MCP_AUTH_TOKEN
# el proceso se niega a arrancar (trampa 12), asi que no hay forma de dejarlo abierto por descuido.
ENTRYPOINT ["node", "dist/cli.js"]
