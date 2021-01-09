#!/bin/sh -e
cd $(dirname $0)
lftp -f unavailable.lftp
