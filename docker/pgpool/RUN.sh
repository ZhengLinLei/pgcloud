#!/bin/bash

if [ ! -f ./.env ]; then
    echo "Missing .env. Create it with: cp .env.example .env  (and set your passwords)"
    exit 1
fi

IMAGE_NAME=pgcloud_pool
CONTAINER_NAME=pgcloud_pool


docker run  -dit --rm --network=host          \
            --name $CONTAINER_NAME            \
            --env-file ./.env                 \
            -v /etc/localtime:/etc/localtime  \
            -v ./.env:/opt/pgcloud/.env       \
            -v ./conf/pgpool:/opt/pgcloud/conf/pgpool       \
            -v ./conf/postgres:/opt/pgcloud/conf/postgres   \
            -v ./conf/pgbouncer:/opt/pgcloud/conf/pgbouncer \
            $IMAGE_NAME bash

docker exec -it $CONTAINER_NAME bash


docker stop $CONTAINER_NAME

# docker volume rm pgdata pgcdata