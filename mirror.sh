#!/bin/sh
set -e
cd $(dirname $0)
wget --quiet --tries=10 --waitretry=0.5 --retry-connrefused --output-document=/dev/null $(head -n 1 urls.txt)
wget --quiet --directory-prefix=www --mirror --no-host-directories --input-file=urls.txt
lftp -f mirror.lftp
