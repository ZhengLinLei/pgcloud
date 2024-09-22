# From ubuntu 24.04
FROM ubuntu:24.04

RUN apt-get update
RUN apt-get install -y                  \
                    pgpool2             \
                    vim                 \
                    postgresql-client   \
                    netcat              \
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

# Set the permissions
RUN chmod +x ./sbin/*.sh
RUN chmod +x ./script/*.sh
RUN chmod +x ./tools/*.sh

# Create link command -> bash script file
# pgcloud_failover in /bin link to ./sbin/failover.sh
RUN ln -s ./sbin/failover.sh /bin/pgcloud_failover
# pgcloud_failback in /bin link to ./sbin/failback.sh
RUN ln -s ./sbin/failback.sh /bin/pgcloud_failback

# Set read/write permissions to config files and all files
RUN chmod 777 ./conf



ENTRYPOINT [ "./sbin/entrypoint.sh" ]