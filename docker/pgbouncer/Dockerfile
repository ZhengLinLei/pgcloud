# From rhel 9.4
FROM registry.access.redhat.com/ubi9/ubi:9.4

RUN yum update -y
RUN yum install -y https://dl.fedoraproject.org/pub/epel/epel-release-latest-9.noarch.rpm
RUN yum install -y  wget            \
                    vim             \
                    net-tools       \
                    cronolog        \
                    gcc             \
                    make            \
                    openssl-devel   \
                    libevent        \
                    libevent-devel  \
                    libtool         \
                    postgresql

# Install pgbouncer
RUN wget https://pgbouncer.github.io/downloads/files/1.23.1/pgbouncer-1.23.1.tar.gz \
    && tar -xvzf pgbouncer-1.23.1.tar.gz \
    && cd pgbouncer-1.23.1 \
    && ./configure \
    && make \
    && make install \
    && cd .. \
    && rm -rf pgbouncer-1.23.1 pgbouncer-1.23.1.tar.gz

# Remove the build dependencies
RUN yum remove -y gcc make

# Set the default shell
RUN echo "alias grep='grep --color=auto'" >> /root/.bashrc
RUN echo "alias ls='ls --color=auto'" >> /root/.bashrc

WORKDIR /opt/pgcloud

ENV PGCDATA=/opt/pgcloud

# Create pgbouncer user with root group
RUN useradd -r -g root pgbouncer

# Copy the data
COPY ./static/pgbouncer/ .

# Make conf file editable by pgbouncer user
RUN chmod g+rw ./conf/pgbouncer.ini
RUN chmod g+rw ./conf/auth_file.cfg

RUN mkdir -p ./log

# Set the permissions
RUN chmod +x ./sbin/*.sh
RUN chmod +x ./script/*.sh


# Set read/write permissions to config files and all files
RUN chmod 777 ./conf



ENTRYPOINT [ "./sbin/entrypoint.sh" ]