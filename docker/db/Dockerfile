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

# Set read/write permissions to config files and all files
RUN chmod 777 ./conf

# Add the postgres user to sudoers
RUN usermod -aG sudo postgres
# Set no password for sudo to postgres user
RUN echo "postgres  ALL=(ALL)   NOPASSWD: ALL" >> /etc/sudoers

# Own entrypoint
ENTRYPOINT [ "./sbin/entrypoint.sh" ]
CMD ["postgres"]
