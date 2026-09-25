# ASTECH Explorer — image Linux avec Oracle Instant Client embarqué (mode THICK).
# Base Oracle Linux 8 : fournit le client Oracle et les libs système (libaio) requis
# par node-oracledb en mode thick. Node.js 20 est installé depuis le binaire officiel.
FROM oraclelinux:8

# 1) Client Oracle Instant Client (basic) via le dépôt Oracle Linux.
RUN dnf -y install oracle-instantclient-release-el8 && \
    dnf -y install oracle-instantclient-basic && \
    dnf -y install tar gzip curl && \
    dnf clean all && rm -rf /var/cache/dnf

# 2) Node.js 20 (binaire officiel, glibc).
ARG NODE_VERSION=20.18.0
RUN curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.gz" -o /tmp/node.tar.gz && \
    tar -xzf /tmp/node.tar.gz -C /usr/local --strip-components=1 && \
    rm /tmp/node.tar.gz

# 3) Expose le dossier des libs Instant Client (chemin versionné -> lien stable).
RUN set -eux; \
    libdir="$(dirname "$(find /usr/lib/oracle -name 'libclntsh.so.*' -type f | head -n1)")"; \
    test -n "$libdir" && test -d "$libdir"; \
    mkdir -p /opt/oracle; \
    rm -f /opt/oracle/instantclient; \
    ln -s "$libdir" /opt/oracle/instantclient; \
    echo "Instant Client: $libdir"
ENV ORACLE_CLIENT_LIB_DIR=/opt/oracle/instantclient
ENV LD_LIBRARY_PATH=/opt/oracle/instantclient

ENV NODE_ENV=production
ENV PORT=8099

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm install --omit=dev
COPY server.js ./
COPY public ./public

EXPOSE 8099
CMD ["node", "server.js"]
