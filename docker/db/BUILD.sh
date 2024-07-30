#!/bin/bash


IMAGE_NAME=pgcloud

# Build the docker image for the pgcloud database
docker build -f ./Dockerfile -t $IMAGE_NAME ../..
