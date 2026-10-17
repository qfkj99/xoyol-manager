#!/bin/sh
set -eu
umask 077

# A host-created bind directory is often owned by root. Repair only the mounted
# data directory, then run the application and admin commands as the node user.
if [ "$(id -u)" = "0" ]; then
    mkdir -p /app/data
    chown -R node:node /app/data
    chmod 700 /app/data
    exec gosu node "$@"
fi

exec "$@"
