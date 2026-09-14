# syntax=docker/dockerfile:1
FROM ubuntu:24.04

RUN apt-get update \
    && apt-get install -y --no-install-recommends openssh-server \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --shell /bin/bash tester \
    && printf '%s\n' 'set enable-bracketed-paste off' > /home/tester/.inputrc \
    && chown tester:tester /home/tester/.inputrc \
    && mkdir -p /run/sshd \
    && rm -f /etc/ssh/ssh_host_*_key /etc/ssh/ssh_host_*_key.pub \
    && ssh-keygen -t ed25519 -f /etc/ssh/ssh_host_ed25519_key -N '' \
    && ssh-keygen -t rsa -b 4096 -f /etc/ssh/ssh_host_rsa_key -N '' \
    && sed -i 's/^#\?PasswordAuthentication .*/PasswordAuthentication yes/' /etc/ssh/sshd_config \
    && sed -i 's/^#\?PermitRootLogin .*/PermitRootLogin no/' /etc/ssh/sshd_config \
    && sed -i 's/^#\?KbdInteractiveAuthentication .*/KbdInteractiveAuthentication no/' /etc/ssh/sshd_config

COPY <<'EOF' /usr/local/bin/run-sshd
#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${SSH_PASSWORD:-}" ]]; then
  echo "SSH_PASSWORD is required" >&2
  exit 1
fi

echo "tester:${SSH_PASSWORD}" | chpasswd
exec /usr/sbin/sshd -D -e
EOF

RUN chmod 0755 /usr/local/bin/run-sshd

EXPOSE 22

CMD ["/usr/local/bin/run-sshd"]
