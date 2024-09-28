#!/bin/bash


IMAGE_NAME=pgcloud_bouncer

# Build the docker image for the pgcloud pgpool
docker build -f ./Dockerfile -t $IMAGE_NAME ../..

# Remove <none> images 
yes | docker image prune