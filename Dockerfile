# oath: CLI + admission webhook. No runtime dependencies.
FROM node:22-alpine
WORKDIR /oath
COPY package.json ./
COPY lib ./lib
COPY bin ./bin
USER 1000:1000
EXPOSE 8443
ENTRYPOINT ["node"]
CMD ["bin/oath-webhook.mjs"]
