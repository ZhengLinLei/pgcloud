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
ENV PGDATA=/opt/pgdata

# Own directories
ENV PGCBASE=/opt/pgcloud
ENV PGCLOG=/opt/pgcloud/log

# Copy new data
COPY ./static/db/conf ./conf
COPY ./static/db/script ./script
COPY ./static/db/sys ./sys

# Create folder
RUN mkdir log

# Make sure execution permissions
RUN chmod +x ./sys/*.sh ./script/*.sh


# Call entrypoint
ENTRYPOINT ["./sys/entrypoint.sh"]

