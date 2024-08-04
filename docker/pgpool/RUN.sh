#!/bin/bash

IMAGE_NAME=pgcloud_pool
CONTAINER_NAME=pgcloud_pool


docker run  -dit --rm --network=host           \
            --name $CONTAINER_NAME            \
            --env-file ./.env                 \
            -v /etc/localtime:/etc/localtime  \
            -v ./.env:/opt/pgcloud/.env       \
            $IMAGE_NAME bash

docker exec -it $CONTAINER_NAME bash


docker stop $CONTAINER_NAME

# docker volume rm pgdata pgcdata