#!/bin/bash

IMAGE_NAME=pgcloud_db
CONTAINER_NAME=pgcloud_db
VOLUME_NAME=pgdata

# -- Linux interface docker0: flags=4163<UP,BROADCAST,RUNNING,MULTICAST>  mtu 1500
# docker run  -it --rm --network=host           \
#             --name $CONTAINER_NAME            \
#             --env-file ./.env                 \
#             -v /etc/localtime:/etc/localtime  \
#             -v pgdata:/opt/pgdata             \
#             -v ./.env:/opt/pgcloud/.env       \
#             $IMAGE_NAME

# -- Mac OS interface docker0: flags=8843<UP,BROADCAST,RUNNING,SIMPLEX,MULTICAST> mtu 1500
# Make sure to change expose port if you want to change the Postgres port in .env
docker run  -dit --rm                         \
            --name $CONTAINER_NAME            \
            -p 5432:5432                      \
            --env-file ./.env                 \
            -v /etc/localtime:/etc/localtime  \
            -v $VOLUME_NAME:/opt/pgdata       \
            -v ./.env:/opt/pgcloud/.env       \
            $IMAGE_NAME

# If you are running in same machine, and want to use second instance in MacOS / WIndow. Include
# host.docker.internal as 127.0.0.1 lp IP


docker exec -it $CONTAINER_NAME bash


docker stop $CONTAINER_NAME

# docker volume rm pgdata pgcdata