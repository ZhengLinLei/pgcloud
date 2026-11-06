# Fake "server" for trying the launcher locally: Docker-in-Docker + OpenSSH with password login.
# FOR TESTING ONLY: root login with a fixed password, privileged container.
FROM docker:27-dind

ARG ROOT_PASSWORD=pgcloud-test

RUN apk upgrade --no-cache \
 && apk add --no-cache openssh-server bash \
 && ssh-keygen -A \
 && sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin yes/; s/^#\?PasswordAuthentication.*/PasswordAuthentication yes/' /etc/ssh/sshd_config \
 && echo "root:${ROOT_PASSWORD}" | chpasswd \
 && printf '#!/bin/sh\n/usr/sbin/sshd\nexec dockerd-entrypoint.sh "$@"\n' > /start.sh \
 && chmod +x /start.sh

ENTRYPOINT ["/start.sh"]
