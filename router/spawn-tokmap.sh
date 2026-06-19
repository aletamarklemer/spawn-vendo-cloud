#!/bin/sh
mkdir -p /etc/opennds/htdocs/tok /etc/opennds/htdocs/ip
while :; do
  ndsctl json 2>/dev/null | awk '
    /"mac"/ { gsub(/.*"mac":"|".*/,""); mac=$0 }
    /"ip"/ { gsub(/.*"ip":"|".*/,""); ip=$0 }
    /"token"/ { gsub(/.*"token":"|".*/,""); tok=$0; print tok" "ip" "mac }
  ' > /tmp/tokmap.txt
  while read tok ip mac; do
    echo "{\"ip\":\"$ip\",\"mac\":\"$mac\"}" > /etc/opennds/htdocs/tok/${tok}.json
    [ -n "$ip" ] && echo "{\"ip\":\"$ip\",\"mac\":\"$mac\"}" > /etc/opennds/htdocs/ip/${ip}.json
  done < /tmp/tokmap.txt
  sleep 2
done
