#!/bin/sh
set -e
cd $(dirname $0)
lftp -f unavailable.lftp
