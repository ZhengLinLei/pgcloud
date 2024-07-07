#!/bin/bash
docker run -dit --rm --name pgcloud \
  --env-file ./.env \
  -v pgdata:/opt/pgdata \
  -v pgcdata:/opt/pgcloud/log \
  -p 5432:5432 pgcloud

docker exec -it pgcloud bash


docker stop pgcloud