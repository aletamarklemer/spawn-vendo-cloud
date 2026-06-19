#!/bin/sh
. /etc/spawn-enforce.conf
LOG_TAG="spawn-enforce"
URL="$API_BASE/api/enforcement/allowed"
[ -n "$DEVICE_ID" ] && URL="$URL?device_id=$DEVICE_ID"
log() { logger -t "$LOG_TAG" "$1"; }
TC=/usr/bin/spawn-tc.sh

# Device-level speed (Mbps) - fallback default
DEV_DL=0
DEV_UL=0

fetch_speed() {
  SP="$(curl -s -m 8 -H "x-device-key: $DEVICE_KEY" "$API_BASE/api/devices/speed?device_id=$DEVICE_ID")"
  [ -z "$SP" ] && return
  dl="$(echo "$SP" | sed -n 's/.*"download_mbps":\([0-9]*\).*/\1/p')"
  ul="$(echo "$SP" | sed -n 's/.*"upload_mbps":\([0-9]*\).*/\1/p')"
  [ -n "$dl" ] && DEV_DL=$dl
  [ -n "$ul" ] && DEV_UL=$ul
}

get_ip() {
  echo "$NDS_JSON" | grep -A6 "\"mac\":\"$1\"" | grep '"ip"' | head -1 | sed 's/.*"ip":"//;s/".*//'
}

get_voucher_speed() {
  mac_up="$(echo "$1" | tr 'a-f' 'A-F')"
  blk="$(echo "$RESP" | sed -n 's/.*"speeds":{\(.*\)}.*/\1/p')"
  entry="$(echo "$blk" | grep -o "\"MAC:$mac_up\":{[^}]*}")"
  [ -z "$entry" ] && return
  vdl="$(echo "$entry" | sed -n 's/.*"download_mbps":\([0-9]*\).*/\1/p')"
  vul="$(echo "$entry" | sed -n 's/.*"upload_mbps":\([0-9]*\).*/\1/p')"
  [ -z "$vdl" ] && vdl=0
  [ -z "$vul" ] && vul=0
  echo "$vdl $vul"
}

apply_tc() {
  mac="$1"
  ip="$(get_ip "$mac")"
  [ -z "$ip" ] && return
  vs="$(get_voucher_speed "$mac")"
  if [ -n "$vs" ]; then
    dl="$(echo "$vs" | cut -d' ' -f1)"
    ul="$(echo "$vs" | cut -d' ' -f2)"
  else
    dl="$DEV_DL"
    ul="$DEV_UL"
  fi
  flag="/tmp/tc_$mac"
  want="${dl}_${ul}_${ip}"
  cur=""
  [ -f "$flag" ] && cur="$(cat "$flag")"
  if [ "$cur" != "$want" ]; then
    if [ "$dl" -gt 0 ] || [ "$ul" -gt 0 ]; then
      $TC limit "$ip" "$dl" "$ul" 2>/dev/null
      log "TC LIMIT $ip dl=${dl} ul=${ul} Mbps"
    else
      $TC clear "$ip" 2>/dev/null
    fi
    echo "$want" > "$flag"
  fi
}

clear_tc() {
  mac="$1"
  flag="/tmp/tc_$mac"
  if [ -f "$flag" ]; then
    ip="$(cat "$flag" | cut -d_ -f3)"
    [ -n "$ip" ] && $TC clear "$ip" 2>/dev/null
    rm -f "$flag"
  fi
}

sync_once() {
  # Self-heal: nft rules + walledgarden + uhttpd
  nft list chain ip nds_filter ndsRTR 2>/dev/null | grep -q "3000" || nft insert rule ip nds_filter ndsRTR tcp dport 3000 accept 2>/dev/null
  nft list chain ip nds_filter ndsRTR 2>/dev/null | grep -q "8080" || nft insert rule ip nds_filter ndsRTR tcp dport 8080 accept 2>/dev/null
  nft list set ip nds_filter walledgarden 2>/dev/null | grep -q "69.46.46.4" || nft add element ip nds_filter walledgarden { 69.46.46.4 } 2>/dev/null
  pgrep -f "uhttpd.*3000" >/dev/null || uhttpd -f -p 10.0.0.1:3000 -h /etc/opennds/htdocs -I insert-coin.html -x /cgi-bin -n 3 &
  tc qdisc show dev br-lan 2>/dev/null | grep -q "htb 1:" || $TC init 2>/dev/null

  RESP="$(curl -s -m 10 -H "x-device-key: $DEVICE_KEY" "$URL")"
  [ -z "$RESP" ] && return 1

  fetch_speed

  NDS_JSON=""
  for try in 1 2 3; do
    NDS_JSON="$(ndsctl json 2>/dev/null)"
    [ -n "$NDS_JSON" ] && echo "$NDS_JSON" | grep -q '"client_list_length"' && break
    sleep 1
  done
  echo "$NDS_JSON" | grep -q '"client_list_length"' || return 0

  ACTIVE_MACS="$(echo "$RESP" | sed -n 's/.*"macs":\[\([^]]*\)\].*/\1/p' | tr ',' '\n' | sed 's/[", ]//g' | grep -v '^$' | sed 's/^MAC://' | tr 'A-F' 'a-f')"
  PAUSED_MACS="$(echo "$RESP" | sed -n 's/.*"paused_macs":\[\([^]]*\)\].*/\1/p' | tr ',' '\n' | sed 's/[", ]//g' | grep -v '^$' | sed 's/^MAC://' | tr 'A-F' 'a-f')"
  CONNECTED_MACS="$(echo "$NDS_JSON" | grep '"mac"' | sed 's/.*"mac":"//;s/".*//')"

  # ACTIVE sessions: ensure authenticated + apply speed (NO idle auto-pause)
  for mac in $ACTIVE_MACS; do
    if echo "$CONNECTED_MACS" | grep -qi "$mac"; then
      state="$(echo "$NDS_JSON" | grep -A30 "\"mac\":\"$mac\"" | grep '"state"' | head -1 | sed 's/.*"state":"//;s/".*//')"
      [ "$state" != "Authenticated" ] && ndsctl auth "$mac" >/dev/null 2>&1 && log "AUTH $mac"
      apply_tc "$mac"
    fi
  done

  # PAUSED sessions (paused via manual button): deauth to cut internet (time stops)
  for mac in $PAUSED_MACS; do
    if echo "$CONNECTED_MACS" | grep -qi "$mac"; then
      state="$(echo "$NDS_JSON" | grep -A30 "\"mac\":\"$mac\"" | grep '"state"' | head -1 | sed 's/.*"state":"//;s/".*//')"
      if [ "$state" = "Authenticated" ]; then
        clear_tc "$mac"
        ndsctl deauth "$mac" >/dev/null 2>&1 && log "DEAUTH $mac (paused)"
      fi
    fi
  done

  # Connected but NOT in active/paused (expired/none): deauth
  for mac in $CONNECTED_MACS; do
    state="$(echo "$NDS_JSON" | grep -A30 "\"mac\":\"$mac\"" | grep '"state"' | head -1 | sed 's/.*"state":"//;s/".*//')"
    if ! echo "$ACTIVE_MACS" | grep -qi "$mac" && ! echo "$PAUSED_MACS" | grep -qi "$mac"; then
      if [ "$state" = "Authenticated" ]; then
        clear_tc "$mac"
        ndsctl deauth "$mac" >/dev/null 2>&1 && log "DEAUTH $mac"
      fi
    fi
  done
}

$TC init 2>/dev/null
log "starting (manual-only mode); polling every ${POLL_INTERVAL}s"
while :; do sync_once; sleep "$POLL_INTERVAL"; done
