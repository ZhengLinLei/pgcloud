# From rhel 9.4
FROM registry.access.redhat.com/ubi9/ubi:9.4

RUN yum update -y
RUN yum install -y                  \
                    pgbouncer       \
                    vim             \
                    net-tools       \
                    cronolog

# Set the default shell
RUN echo "alias grep='grep --color=auto'" >> /root/.bashrc
RUN echo "alias ls='ls --color=auto'" >> /root/.bashrc

WORKDIR /opt/pgcloud

ENV PGCDATA=/opt/pgcloud

# Copy the data
COPY ./static/pgbouncer/ .

# Set the permissions
RUN chmod +x ./sbin/*.sh
RUN chmod +x ./script/*.sh


# Set read/write permissions to config files and all files
RUN chmod 777 ./conf



ENTRYPOINT [ "./sbin/entrypoint.sh" ]