# Using ubuntu as base Operative system
# Usig own base can detach postgres entrypoint.sh
FROM ubuntu:24.04

# Make the shell noon interactive
ENV DEBIAN_FRONTEND=noninteractive

# Update and install PostgreSQL 16 - Default in Ubuntu 24.04
RUN apt-get update
RUN apt-get install -y  postgresql          \
                    postgresql-contrib  \
                    postgresql-client   \
                    vim
RUN apt-get clean
RUN rm -rf /var/lib/apt/lists/*


# Copy all init files to PostgreSQL image
COPY ./static/db/init /docker-entrypoint-initdb.d


# Copy files to workdir
WORKDIR /opt/pgcloud
ENV WORKDIR=/opt/pgcloud
ENV PGVERSION=16
ENV PGDIR=/var/lib/postgresql
ENV PGLOG=/var/log/postgresql

COPY ./static/db/conf ./conf
COPY ./static/db/script ./script
COPY ./static/db/sys ./sys

# Make sure execution permissions
RUN chmod +x ./sys/*.sh ./script/*.sh


# Call entrypoint
ENTRYPOINT ["./sys/entrypoint.sh"]

