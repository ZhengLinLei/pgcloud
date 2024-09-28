# Using postgresql 16 with own entrypoint
# This image is used to create a PostgreSQL 16 image with own entrypoint
# The entrypoint will create the database, user and password
# The entrypoint will also start the PostgreSQL service
FROM postgres:16

# Install and update
RUN apt update
RUN apt upgrade -y

# Install dependencies
RUN apt install -y  vim  \
                    curl \
                    wget \
                    sudo \
                    procps \
                    net-tools \
                    iputils-ping \
                    htop

# Set the default shell
RUN echo "alias grep='grep --color=auto'" >> /root/.bashrc
RUN echo "alias ls='ls --color=auto'" >> /root/.bashrc

# Copy files to workdir
WORKDIR /opt/pgcloud

ENV PGCDATA=/opt/pgcloud

# Copy the data
COPY ./static/db/ .

# Set the permissions
RUN chmod +x ./sbin/*.sh
RUN chmod +x ./script/*.sh
RUN chmod +x ./tools/*.sh

# Create link command -> bash script file
# pgcloud_promote in /bin link to ./sbin/promote.sh
RUN ln -s ./sbin/promote.sh /bin/pgcloud_promote
# pgcloud_redirect
RUN ln -s ./sbin/redirect.sh /bin/pgcloud_redirect
# pgcloud_depromote
RUN ln -s ./sbin/depromote.sh /bin/pgcloud_depromote

# Set read/write permissions to config files and all files
RUN chmod 777 ./conf

# Add the postgres user to sudoers
RUN usermod -aG sudo postgres
# Set no password for sudo to postgres user
RUN echo "postgres  ALL=(ALL)   NOPASSWD: ALL" >> /etc/sudoers

# Set log folder to postgresql user
RUN mkdir -p ./log
RUN chown -R postgres:postgres ./log

# Own entrypoint
ENTRYPOINT [ "./sbin/entrypoint.sh" ]

# We set the default STOPSIGNAL to SIGINT, which corresponds to what PostgreSQL
# calls "Fast Shutdown mode" wherein new connections are disallowed and any
# in-progress transactions are aborted, allowing PostgreSQL to stop cleanly and
# flush tables to disk, which is the best compromise available to avoid data
# corruption.
#
# Users who know their applications do not keep open long-lived idle connections
# may way to use a value of SIGTERM instead, which corresponds to "Smart
# Shutdown mode" in which any existing sessions are allowed to finish and the
# server stops when all sessions are terminated.
#
# See https://www.postgresql.org/docs/12/server-shutdown.html for more details
# about available PostgreSQL server shutdown signals.
#
# See also https://www.postgresql.org/docs/12/server-start.html for further
# justification of this as the default value, namely that the example (and
# shipped) systemd service files use the "Fast Shutdown mode" for service
# termination.
#
STOPSIGNAL SIGINT
#
# An additional setting that is recommended for all users regardless of this
# value is the runtime "--stop-timeout" (or your orchestrator/runtime's
# equivalent) for controlling how long to wait between sending the defined
# STOPSIGNAL and sending SIGKILL (which is likely to cause data corruption).
#
# The default in most runtimes (such as Docker) is 10 seconds, and the
# documentation at https://www.postgresql.org/docs/12/server-start.html notes
# that even 90 seconds may not be long enough in many instances.

EXPOSE 5432
# Don't need to expose own port

CMD ["postgres"]
