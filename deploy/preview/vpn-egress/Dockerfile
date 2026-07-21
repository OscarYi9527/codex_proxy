FROM debian:bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    openvpn \
    tinyproxy \
  && rm -rf /var/lib/apt/lists/*

COPY --chmod=0555 deploy/preview/vpn-egress/entrypoint.sh \
  /usr/local/bin/vpn-egress-entrypoint
COPY --chmod=0444 deploy/preview/vpn-egress/tinyproxy.conf \
  /etc/tinyproxy/tinyproxy.conf

ENTRYPOINT ["/usr/local/bin/vpn-egress-entrypoint"]
