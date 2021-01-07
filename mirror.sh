#!/bin/sh -e
cd $(dirname $0)
wget -q -P www -m -nH -i urls.txt
lftp -f lftp.dat
