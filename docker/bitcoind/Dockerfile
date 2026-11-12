# syntax=docker/dockerfile:1
# Bitcoin Core regtest node for tests. Official release tarball, SHA-256 pinned per arch.
# The hashes come from https://bitcoincore.org/bin/bitcoin-core-<version>/SHA256SUMS. To update:
# change BITCOIN_VERSION, copy the two bitcoin-<version>-{aarch64,x86_64}-linux-gnu.tar.gz lines
# from that file into SHA256_ARM64 and SHA256_AMD64 (and check its SHA256SUMS.asc signatures).
ARG DEBIAN=debian:trixie-slim

FROM ${DEBIAN} AS fetch
ARG TARGETARCH
ARG BITCOIN_VERSION=32.1
ARG SHA256_ARM64=7ed37c7373eb6aa3e3f72842596a1afeba1b223717033cade9842b25773e1922
ARG SHA256_AMD64=61545c17c3120fb7412f896d248b11993af04ec8817aad3649c55b2afb044963
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /tmp/btc
RUN set -eux; \
    case "${TARGETARCH}" in \
      arm64) triple=aarch64-linux-gnu; sha="${SHA256_ARM64}" ;; \
      amd64) triple=x86_64-linux-gnu;  sha="${SHA256_AMD64}" ;; \
      *) echo "unsupported TARGETARCH=${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    f="bitcoin-${BITCOIN_VERSION}-${triple}.tar.gz"; \
    curl -fsSLO "https://bitcoincore.org/bin/bitcoin-core-${BITCOIN_VERSION}/${f}"; \
    echo "${sha}  ${f}" | sha256sum -c -; \
    tar -xzf "${f}"; \
    install -m 0755 "bitcoin-${BITCOIN_VERSION}/bin/bitcoind" "bitcoin-${BITCOIN_VERSION}/bin/bitcoin-cli" /usr/local/bin/

FROM ${DEBIAN}
COPY --from=fetch /usr/local/bin/bitcoind /usr/local/bin/bitcoin-cli /usr/local/bin/
RUN useradd --system --create-home --uid 1000 bitcoin \
 && mkdir -p /home/bitcoin/.bitcoin && chown bitcoin:bitcoin /home/bitcoin/.bitcoin
USER bitcoin
EXPOSE 18443
ENTRYPOINT ["bitcoind"]
CMD ["-regtest", "-printtoconsole"]
