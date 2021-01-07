#!/bin/sh
wget -P www -m -nH -i urls.txt
lftp -f lftp.dat
