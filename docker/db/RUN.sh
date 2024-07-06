#!/bin/bash
docker run -dit --rm --name pgcloud \
  -e PGDDBB=aa \
  -e PGUSER=a \
  -e PGPASS=a \
  -e PGNAME=pgcloud \
  -p 5432:5432 pgcloud

docker exec -it pgcloud bash


docker stop pgcloud