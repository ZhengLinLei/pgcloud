#!/usr/bin/env bash
set -Eeo pipefail

# Check if $PGDATA/log exists, if not, create it
if [ ! -d "$PGCDATA/log" ]; then
	mkdir -p $PGCDATA/log
fi

# Check if $PGDATA/log/pgcloud.log exists, if not, create it
if [ ! -f "$PGCDATA/log/pgcloud.log" ]; then
	touch $PGCDATA/log/pgcloud.log
	chmod 666 $PGCDATA/log/pgcloud.log
fi

pglog () {
    printf '%s  |  %s\n' "$(date)" "$@" >> $PGCDATA/log/pgcloud.log
}

# TODO swap to -Eeuo pipefail above (after handling all potentially-unset variables)

# usage: file_env VAR [DEFAULT]
#    ie: file_env 'XYZ_DB_PASSWORD' 'example'
# (will allow for "$XYZ_DB_PASSWORD_FILE" to fill in the value of
#  "$XYZ_DB_PASSWORD" from a file, especially for Docker's secrets feature)
file_env() {
	local var="$1"
	local fileVar="${var}_FILE"
	local def="${2:-}"
	if [ "${!var:-}" ] && [ "${!fileVar:-}" ]; then
		printf >&2 'error: both %s and %s are set (but are exclusive)\n' "$var" "$fileVar"
		exit 1
	fi
	local val="$def"
	if [ "${!var:-}" ]; then
		val="${!var}"
	elif [ "${!fileVar:-}" ]; then
		val="$(< "${!fileVar}")"
	fi
	export "$var"="$val"
	unset "$fileVar"
}

# check to see if this file is being run or sourced from another script
_is_sourced() {
	# https://unix.stackexchange.com/a/215279
	[ "${#FUNCNAME[@]}" -ge 2 ] \
		&& [ "${FUNCNAME[0]}" = '_is_sourced' ] \
		&& [ "${FUNCNAME[1]}" = 'source' ]
}

# used to create initial postgres directories and if run as root, ensure ownership to the "postgres" user
docker_create_db_directories() {
	local user; user="$(id -u)"

	mkdir -p "$PGDATA"
	# ignore failure since there are cases where we can't chmod (and PostgreSQL might fail later anyhow - it's picky about permissions of this directory)
	chmod 00700 "$PGDATA" || :

	# ignore failure since it will be fine when using the image provided directory; see also https://github.com/docker-library/postgres/pull/289
	mkdir -p /var/run/postgresql || :
	chmod 03775 /var/run/postgresql || :

	# Create the transaction log directory before initdb is run so the directory is owned by the correct user
	if [ -n "${POSTGRES_INITDB_WALDIR:-}" ]; then
		mkdir -p "$POSTGRES_INITDB_WALDIR"
		if [ "$user" = '0' ]; then
			find "$POSTGRES_INITDB_WALDIR" \! -user postgres -exec chown postgres '{}' +
		fi
		chmod 700 "$POSTGRES_INITDB_WALDIR"
	fi

	# allow the container to be started with `--user`
	if [ "$user" = '0' ]; then
		find "$PGDATA" \! -user postgres -exec chown postgres '{}' +
		find /var/run/postgresql \! -user postgres -exec chown postgres '{}' +
	fi
}

# initialize empty PGDATA directory with new database via 'initdb'
# arguments to `initdb` can be passed via POSTGRES_INITDB_ARGS or as arguments to this function
# `initdb` automatically creates the "postgres", "template0", and "template1" dbnames
# this is also where the database user is created, specified by `POSTGRES_USER` env
docker_init_database_dir() {
	# "initdb" is particular about the current user existing in "/etc/passwd", so we use "nss_wrapper" to fake that if necessary
	# see https://github.com/docker-library/postgres/pull/253, https://github.com/docker-library/postgres/issues/359, https://cwrap.org/nss_wrapper.html
	local uid; uid="$(id -u)"
	if ! getent passwd "$uid" &> /dev/null; then
		# see if we can find a suitable "libnss_wrapper.so" (https://salsa.debian.org/sssd-team/nss-wrapper/-/commit/b9925a653a54e24d09d9b498a2d913729f7abb15)
		local wrapper
		for wrapper in {/usr,}/lib{/*,}/libnss_wrapper.so; do
			if [ -s "$wrapper" ]; then
				NSS_WRAPPER_PASSWD="$(mktemp)"
				NSS_WRAPPER_GROUP="$(mktemp)"
				export LD_PRELOAD="$wrapper" NSS_WRAPPER_PASSWD NSS_WRAPPER_GROUP
				local gid; gid="$(id -g)"
				printf 'postgres:x:%s:%s:PostgreSQL:%s:/bin/false\n' "$uid" "$gid" "$PGDATA" > "$NSS_WRAPPER_PASSWD"
				printf 'postgres:x:%s:\n' "$gid" > "$NSS_WRAPPER_GROUP"
				break
			fi
		done
	fi

	if [ -n "${POSTGRES_INITDB_WALDIR:-}" ]; then
		set -- --waldir "$POSTGRES_INITDB_WALDIR" "$@"
	fi

	# --pwfile refuses to handle a properly-empty file (hence the "\n"): https://github.com/docker-library/postgres/issues/1025
	eval 'initdb --username="$POSTGRES_USER" --pwfile=<(printf "%s\n" "$POSTGRES_PASSWORD") '"$POSTGRES_INITDB_ARGS"' "$@"'

	# unset/cleanup "nss_wrapper" bits
	if [[ "${LD_PRELOAD:-}" == */libnss_wrapper.so ]]; then
		rm -f "$NSS_WRAPPER_PASSWD" "$NSS_WRAPPER_GROUP"
		unset LD_PRELOAD NSS_WRAPPER_PASSWD NSS_WRAPPER_GROUP
	fi
}

# print large warning if POSTGRES_PASSWORD is long
# error if both POSTGRES_PASSWORD is empty and POSTGRES_HOST_AUTH_METHOD is not 'trust'
# print large warning if POSTGRES_HOST_AUTH_METHOD is set to 'trust'
# assumes database is not set up, ie: [ -z "$DATABASE_ALREADY_EXISTS" ]
docker_verify_minimum_env() {
	case "${PG_MAJOR:-}" in
		12 | 13) # https://github.com/postgres/postgres/commit/67a472d71c98c3d2fa322a1b4013080b20720b98
			# check password first so we can output the warning before postgres
			# messes it up
			if [ "${#POSTGRES_PASSWORD}" -ge 100 ]; then
				cat >&2 <<-'EOWARN'

					WARNING: The supplied POSTGRES_PASSWORD is 100+ characters.

					  This will not work if used via PGPASSWORD with "psql".

					  https://www.postgresql.org/message-id/flat/E1Rqxp2-0004Qt-PL%40wrigleys.postgresql.org (BUG #6412)
					  https://github.com/docker-library/postgres/issues/507

				EOWARN
			fi
			;;
	esac
	if [ -z "$POSTGRES_PASSWORD" ] && [ 'trust' != "$POSTGRES_HOST_AUTH_METHOD" ]; then
		# The - option suppresses leading tabs but *not* spaces. :)
		cat >&2 <<-'EOE'
			Error: Database is uninitialized and superuser password is not specified.
			       You must specify POSTGRES_PASSWORD to a non-empty value for the
			       superuser. For example, "-e POSTGRES_PASSWORD=password" on "docker run".

			       You may also use "POSTGRES_HOST_AUTH_METHOD=trust" to allow all
			       connections without a password. This is *not* recommended.

			       See PostgreSQL documentation about "trust":
			       https://www.postgresql.org/docs/current/auth-trust.html
		EOE
		exit 1
	fi
	if [ 'trust' = "$POSTGRES_HOST_AUTH_METHOD" ]; then
		cat >&2 <<-'EOWARN'
			********************************************************************************
			WARNING: POSTGRES_HOST_AUTH_METHOD has been set to "trust". This will allow
			         anyone with access to the Postgres port to access your database without
			         a password, even if POSTGRES_PASSWORD is set. See PostgreSQL
			         documentation about "trust":
			         https://www.postgresql.org/docs/current/auth-trust.html
			         In Docker's default configuration, this is effectively any other
			         container on the same system.

			         It is not recommended to use POSTGRES_HOST_AUTH_METHOD=trust. Replace
			         it with "-e POSTGRES_PASSWORD=password" instead to set a password in
			         "docker run".
			********************************************************************************
		EOWARN
	fi
}

# usage: docker_process_init_files [file [file [...]]]
#    ie: docker_process_init_files /always-initdb.d/*
# process initializer files, based on file extensions and permissions
docker_process_init_files() {
	# psql here for backwards compatibility "${psql[@]}"
	psql=( docker_process_sql )

	printf '\n'
	local f
	for f; do
		case "$f" in
			*.sh)
				# https://github.com/docker-library/postgres/issues/450#issuecomment-393167936
				# https://github.com/docker-library/postgres/pull/452
				if [ -x "$f" ]; then
					printf '%s: running %s\n' "$0" "$f"
					"$f"
				else
					printf '%s: sourcing %s\n' "$0" "$f"
					. "$f"
				fi
				;;
			*.sql)     printf '%s: running %s\n' "$0" "$f"; docker_process_sql -f "$f"; printf '\n' ;;
			*.sql.gz)  printf '%s: running %s\n' "$0" "$f"; gunzip -c "$f" | docker_process_sql; printf '\n' ;;
			*.sql.xz)  printf '%s: running %s\n' "$0" "$f"; xzcat "$f" | docker_process_sql; printf '\n' ;;
			*.sql.zst) printf '%s: running %s\n' "$0" "$f"; zstd -dc "$f" | docker_process_sql; printf '\n' ;;
			*)         printf '%s: ignoring %s\n' "$0" "$f" ;;
		esac
		printf '\n'
	done
}

# Execute sql script, passed via stdin (or -f flag of pqsl)
# usage: docker_process_sql [psql-cli-args]
#    ie: docker_process_sql --dbname=mydb <<<'INSERT ...'
#    ie: docker_process_sql -f my-file.sql
#    ie: docker_process_sql <my-file.sql
docker_process_sql() {
	local query_runner=( psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --no-password --no-psqlrc )
	if [ -n "$POSTGRES_DB" ]; then
		query_runner+=( --dbname "$POSTGRES_DB" )
	fi

	PGHOST= PGHOSTADDR= "${query_runner[@]}" "$@"
}

# create initial database
# uses environment variables for input: POSTGRES_DB
docker_setup_db() {
	echo "Checking if database $POSTGRES_DB exists ..."
	local dbAlreadyExists
	dbAlreadyExists="$(
		POSTGRES_DB= docker_process_sql --dbname postgres --set db="$POSTGRES_DB" --tuples-only <<-'EOSQL'
			SELECT 1 FROM pg_database WHERE datname = :'db' ;
		EOSQL
	)"
	if [ -z "$dbAlreadyExists" ]; then
		POSTGRES_DB= docker_process_sql --dbname postgres --set db="$POSTGRES_DB" <<-'EOSQL'
			CREATE DATABASE :"db" ;
		EOSQL
		printf '\n'
	fi
	echo "Database $POSTGRES_DB exists ... ok"
}

# Loads various settings that are used elsewhere in the script
# This should be called before any other functions
docker_setup_env() {
	file_env 'POSTGRES_PASSWORD'

	file_env 'POSTGRES_USER' 'postgres'
	file_env 'POSTGRES_DB' "$POSTGRES_USER"
	file_env 'POSTGRES_INITDB_ARGS'
	: "${POSTGRES_HOST_AUTH_METHOD:=}"

	declare -g DATABASE_ALREADY_EXISTS
	: "${DATABASE_ALREADY_EXISTS:=}"
	# look specifically for PG_VERSION, as it is expected in the DB dir
	if [ -s "$PGDATA/PG_VERSION" ]; then
		DATABASE_ALREADY_EXISTS='true'
	fi
}

# append POSTGRES_HOST_AUTH_METHOD to pg_hba.conf for "host" connections
# all arguments will be passed along as arguments to `postgres` for getting the value of 'password_encryption'
pg_setup_hba_conf() {
	# default authentication method is md5 on versions before 14
	# https://www.postgresql.org/about/news/postgresql-14-released-2318/
	if [ "$1" = 'postgres' ]; then
		shift
	fi
	local auth
	# check the default/configured encryption and use that as the auth method
	auth="$(postgres -C password_encryption "$@")"
	: "${POSTGRES_HOST_AUTH_METHOD:=$auth}"
	{
		printf '\n'
		if [ 'trust' = "$POSTGRES_HOST_AUTH_METHOD" ]; then
			printf '# warning trust is enabled for all connections\n'
			printf '# see https://www.postgresql.org/docs/12/auth-trust.html\n'
		fi
		printf 'host all all all %s\n' "$POSTGRES_HOST_AUTH_METHOD"
	} >> "$PGDATA/pg_hba.conf"
}

# start socket-only postgresql server for setting up or running scripts
# all arguments will be passed along as arguments to `postgres` (via pg_ctl)
docker_temp_server_start() {
	if [ "$1" = 'postgres' ]; then
		shift
	fi

	# internal start of server in order to allow setup using psql client
	# does not listen on external TCP/IP and waits until start finishes
	set -- "$@" -c listen_addresses='' -p "${PGPORT:-5432}"

	PGUSER="${PGUSER:-$POSTGRES_USER}" \
	pg_ctl -D "$PGDATA" \
		-o "$(printf '%q ' "$@")" \
		-w start
}

# stop postgresql server after done setting up user and running scripts
docker_temp_server_stop() {
	PGUSER="${PGUSER:-postgres}" \
	pg_ctl -D "$PGDATA" -m fast -w stop
}

# check arguments for an option that would cause postgres to stop
# return true if there is one
_pg_want_help() {
	local arg
	for arg; do
		case "$arg" in
			# postgres --help | grep 'then exit'
			# leaving out -C on purpose since it always fails and is unhelpful:
			# postgres: could not access the server configuration file "/var/lib/postgresql/data/postgresql.conf": No such file or directory
			-'?'|--help|--describe-config|-V|--version)
				return 0
				;;
		esac
	done
	return 1
}

configuration_setup() {
    pglog "                      -------                         "
    pglog ""
    pglog "Starting pgcloud system setup"

    # Check user
    user=$(sudo whoami)
	echo "I am user: $user"

    # Init
    # Apply for general config
    sudo sed -i -e "s/replica_user/${REPLICA_USER}/g" $PGCDATA/conf/pg_hba.conf
    pglog "Updating pg_hba.conf ... ok"

	# Configurate postgres.conf
	pglog "Writing init configuraton on system"
    sys_ram_value=$( free -g -t | awk '/^Total:/{print $2}')
    sys_ram_units="GB"
    pglog "System with $sys_ram_value $sys_ram_units"
	echo "# System with $sys_ram_value $sys_ram_units"				| sudo tee -a $PGCDATA/conf/postgresql.conf
    echo "max_connections               =  $MAX_CONNECTIONS"	   	| sudo tee -a $PGCDATA/conf/postgresql.conf
    echo "shared_buffers                =  $SHARED_BUFFERS"      	| sudo tee -a $PGCDATA/conf/postgresql.conf
    echo "work_mem                      =  $WORK_MEM"      			| sudo tee -a $PGCDATA/conf/postgresql.conf
    echo "effective_cache_size          =  $EFFECTIVE_CACHE_SIZE"  	| sudo tee -a $PGCDATA/conf/postgresql.conf
	echo "maintenance_work_mem 		 	=  $MAINTENANCE_WORK_MEM"	| sudo tee -a $PGCDATA/conf/postgresql.conf
    echo -e "\n"                                         			| sudo tee -a $PGCDATA/conf/postgresql.conf

	# Echo slot
	echo "# Slot id: $(cat $PGCDATA/conf/PGC_SLOT)"           			| sudo tee -a $PGCDATA/conf/postgresql.conf

	# Sync rule
	echo "synchronous_standby_names	 =  '$SYNCHRONOUS_RULE ($SYNCHRONOUS_NAME)'" 	| sudo tee -a $PGCDATA/conf/postgresql.conf
	echo -e "\n"                                         						| sudo tee -a $PGCDATA/conf/postgresql.conf

	# Logs
	if [ "$ENABLE_LOGFILE" = "on" ]; then
		echo "logging_collector 		= on"						| sudo tee -a $PGCDATA/conf/postgresql.conf
		echo "log_directory 			= 'log'"					| sudo tee -a $PGCDATA/conf/postgresql.conf
		echo "log_filename 			 	= '$LOG_FILENAME'"			| sudo tee -a $PGCDATA/conf/postgresql.conf
		echo "log_truncate_on_rotation  = on"						| sudo tee -a $PGCDATA/conf/postgresql.conf
		echo "log_rotation_age 		 	= $LOG_ROTATE_AGE"			| sudo tee -a $PGCDATA/conf/postgresql.conf
		echo "log_rotation_size		 	= 0"						| sudo tee -a $PGCDATA/conf/postgresql.conf
	fi

	# Add port by our own way. Postgres already will set Port with $PGPORT env variable
	echo -e "\n"                       		| sudo tee -a $PGCDATA/conf/postgresql.conf
	echo "port 	= $PGPORT"					| sudo tee -a $PGCDATA/conf/postgresql.conf

	echo -e "\n\n"
    sudo cp -rfa $PGCDATA/conf/*.conf $PGDATA
    pglog "Moving conf files to $PGDATA ... ok"
    # Change owner of the files
    sudo chown -R postgres:postgres $PGDATA

    # Fix permissions after copying files
    chmod 00700 "$PGDATA" || :
}

replication_setup() {
    # Create user replica user
    psql -At -U $POSTGRES_USER -d $POSTGRES_DB -c "CREATE ROLE $REPLICA_USER WITH REPLICATION LOGIN PASSWORD '$REPLICA_PASS';" || {
        echo "PSQL failed"
        pglog "Replica user creation failed"
        exit 1
    }

    pglog "Replica user created ... ok"
}

_main() {
	# if first arg looks like a flag, assume we want to run postgres server
	if [ "${1:0:1}" = '-' ]; then
		set -- postgres "$@"
	fi

	pglog "------------------------------------------------------"
	pglog "|                Preparing entrypoint                |"
	pglog "------------------------------------------------------"
    pglog "                      -------                         "
	if [ "$1" = 'postgres' ] && ! _pg_want_help "$@"; then
		docker_setup_env
		# setup data directories and permissions (when run as root)
		docker_create_db_directories

		# If we are running as root, then restart the script as postgres user
		if [ "$(id -u)" = '0' ]; then
			pglog ""
			pglog "Switching to postgres user ... ok"
			# then restart script as postgres user
			exec gosu postgres "$BASH_SOURCE" "$@"
		fi

		# only run initialization on an empty data directory
		if [ -z "$DATABASE_ALREADY_EXISTS" ]; then
			docker_verify_minimum_env

			pglog "Environment variables are correct ... ok"

			# -----
			# Custom slot id
			slot=$(cat /proc/sys/kernel/random/uuid | md5sum -t | cut -d ' ' -f1)

			# Saving slot id to a file - Remmber that slots are unique and start with 'pgcloud'
			# Saving in temporal folder, then it will be moved to the final destination $PGDATA
			sudo echo $slot > $PGCDATA/conf/PGC_SLOT || {
				pglog "Error saving slot id to file. Please manually set the value to file $PGDATA/PGC_SLOT with the slot id: $slot"
				exit 1
			}
			pglog "Slot generated with id: $slot" 
			# -----

			# Check node role. If it is a primary node, then run the primary setup script
			# If it is replica, do a pg_basebackup from the primary node
			if [ "$NODE_ROLE" = "replica" ]; then
				pglog "Replica node. Running pg_basebackup from primary node ..."
				# pg_basebackup from primary node
				export PGPASSWORD=$REPLICA_PASS
				pg_basebackup -h ${PRIMARY_HOST} -p ${PRIMARY_PORT} -U ${REPLICA_USER} -d "host=${PRIMARY_HOST} port=${PRIMARY_PORT} user=${REPLICA_USER} dbname=${POSTGRES_DB} application_name=${BACKEND_NAME}" -X stream -C -S pgcloud$slot -v -R -w -D ${PGDATA} || {
					echo "Backup failed ... exiting"
					exit 1
				}
                pglog ""
				pglog "     [ok] pg_basebackup from primary node"
                pglog ""
				cat <<-'EOM'

					PostgreSQL backup process complete; ready for start up.

				EOM
			else
				pglog "Primary node. Preparing database ..."

				# check dir permissions to reduce likelihood of half-initialized database
				ls /docker-entrypoint-initdb.d/ > /dev/null

				docker_init_database_dir

				pglog "Database initialized ... ok"

				pg_setup_hba_conf "$@"

				pglog "pg_hba.conf created ... ok"

				# PGPASSWORD is required for psql when authentication is required for 'local' connections via pg_hba.conf and is otherwise harmless
				# e.g. when '--auth=md5' or '--auth-local=md5' is used in POSTGRES_INITDB_ARGS
				export PGPASSWORD="${PGPASSWORD:-$POSTGRES_PASSWORD}"
				docker_temp_server_start "$@"

				pglog "Server started temporally ... ok"

				docker_setup_db
				pglog "Database created ... ok"

                # Replication setup
                replication_setup

				echo "Replication user setup $REPLICA_USER ... ok"

				docker_process_init_files /docker-entrypoint-initdb.d/*

				pglog "Executing user init script ... ok"

				docker_temp_server_stop
				pglog "Server stopped ... ok"

				# Configuration setup
                configuration_setup

				pglog "Custom scripts executed ... ok"

				pglog ""
				pglog "Postgres database ready to use"
                pglog ""
				pglog "     [ok] Postgres primary ready!"
                pglog ""

				unset PGPASSWORD

				cat <<-'EOM'

					PostgreSQL init process complete; ready for start up.

				EOM
			fi
		else
			cat <<-'EOM'

				PostgreSQL Database directory appears to contain a database; Skipping initialization

			EOM
		fi
	fi

	pglog "Starting postgres"
    pglog "------------------------------------------------------"
	echo "Starting postgres"
	exec "$@"
}

if ! _is_sourced; then
	_main "$@"
fi