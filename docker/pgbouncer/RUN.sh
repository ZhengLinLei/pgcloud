#!/bin/bash

if [ ! -f ./.env ]; then
    echo "Missing .env. Create it with: cp .env.example .env  (and set your passwords)"
    exit 1
fi

IMAGE_NAME=pgcloud_bouncer
CONTAINER_NAME=pgcloud_bouncer


docker run  -dit --rm --net=host            \
            --name $CONTAINER_NAME              \
            --env-file ./.env                   \
            -v /etc/localtime:/etc/localtime    \
            -v ./.env:/opt/pgcloud/.env         \
            -v ./conf:/opt/pgcloud/conf/server  \
            $IMAGE_NAME bash

docker exec -it $CONTAINER_NAME bash


docker stop $CONTAINER_NAME

# docker volume rm pgdata pgcdata