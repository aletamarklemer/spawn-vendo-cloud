#!/bin/sh
mkdir -p /etc/opennds/htdocs/tok /etc/opennds/htdocs/ip
CACHE=/tmp/nds-cache.json
while :; do
  NDS="$(ndsctl json 2>/dev/null)"
  if [ -n "$NDS" ]; then
    echo "$NDS" > "$CACHE"
    # Limpyohan ang daan nga tokens (>5 min) para dili mag-accumulate
    find /etc/opennds/htdocs/tok -name '*.json' -mmin +5 -delete 2>/dev/null
    find /etc/opennds/htdocs/ip -name '*.json' -mmin +5 -delete 2>/dev/null
    echo "$NDS" | awk '
      /"mac"/ { gsub(/.*"mac":"|".*/,""); mac=$0 }
      /"ip"/ { gsub(/.*"ip":"|".*/,""); ip=$0 }
      /"token"/ { gsub(/.*"token":"|".*/,""); tok=$0; print tok" "ip" "mac }
    ' > /tmp/tokmap.txt
    while read tok ip mac; do
      [ -n "$tok" ] && echo "{\"ip\":\"$ip\",\"mac\":\"$mac\"}" > /etc/opennds/htdocs/tok/${tok}.json
      [ -n "$ip" ] && echo "{\"ip\":\"$ip\",\"mac\":\"$mac\"}" > /etc/opennds/htdocs/ip/${ip}.json
    done < /tmp/tokmap.txt
  fi
  sleep 2
done
