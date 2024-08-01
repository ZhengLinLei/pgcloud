#!/bin/bash


IMAGE_NAME=pgcloud_db

# Build the docker image for the pgcloud database
docker build -f ./Dockerfile -t $IMAGE_NAME ../..

# Remove <none> images 
yes | docker image prune