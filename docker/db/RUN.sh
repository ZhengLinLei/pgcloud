#!/bin/bash

IMAGE_NAME=pgcloud_db
CONTAINER_NAME=pgcloud_db


docker run  -it --rm --network=host           \
            --name $CONTAINER_NAME            \
            --env-file ./.env                 \
            -v /etc/localtime:/etc/localtime  \
            -v pgdata:/opt/pgdata             \
            -v ./.env:/opt/pgcloud/.env       \
            $IMAGE_NAME

docker exec -it $CONTAINER_NAME bash


docker stop $CONTAINER_NAME

# docker volume rm pgdata pgcdata