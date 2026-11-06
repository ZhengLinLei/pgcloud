# From ubuntu 24.04
FROM ubuntu:24.04

RUN apt-get update
RUN apt-get install -y                  \
                    pgpool2             \
                    vim                 \
                    postgresql-client   \
                    netcat-openbsd              \
                    cronolog            \
                    openssh-client      \
                    sshpass

# Set the default shell
RUN echo "alias grep='grep --color=auto'" >> /root/.bashrc
RUN echo "alias ls='ls --color=auto'" >> /root/.bashrc

WORKDIR /opt/pgcloud

ENV PGCDATA=/opt/pgcloud

# Copy the data
COPY ./static/pgpool/ .

# Copy conf folders `pgpool` `postgres` `pgbouncer`
COPY ./docker/pgpool/conf/pgpool ./conf/pgpool
COPY ./docker/pgpool/conf/postgres ./conf/postgres
COPY ./docker/pgpool/conf/pgbouncer ./conf/pgbouncer

RUN mkdir -p ./log /var/run/pgpool /var/log/pgpool/oiddir

# Set the permissions
RUN chmod +x ./sbin/*.sh
RUN chmod +x ./script/*.sh
RUN chmod +x ./tools/*.sh

# Create link command -> bash script file
# pgcloud_failover in /bin link to ./sbin/failover.sh
RUN ln -s /opt/pgcloud/sbin/failover.sh /bin/pgcloud_failover
# pgcloud_failback in /bin link to ./sbin/failback.sh
RUN ln -s /opt/pgcloud/sbin/failback.sh /bin/pgcloud_failback

# pgpool runs as root inside the container; keep config private
RUN chmod 750 ./conf



ENTRYPOINT [ "./sbin/entrypoint.sh" ]