#!/bin/sh -e
cd $(dirname $0)
wget --quiet --tries=10 --waitretry=0.5 --retry-connrefused --directory-prefix=www --mirror --no-host-directories --input-file=urls.txt
lftp -f mirror.lftp
