#!/data/data/com.termux/files/usr/bin/bash

# -------- FIX FOR TCL ANDROID TV BOOT ---------

export PATH=/data/data/com.termux/files/usr/bin:/system/bin:/system/xbin:$PATH
export HOME=/data/data/com.termux/files/home

LOG="$HOME/boot.log"

echo "$(date) - Boot script STARTED" >> $LOG

# Prevent deep sleep
termux-wake-lock
echo "$(date) - Wake lock applied" >> $LOG

# Tunggu Android siap: network, storage, termux-daemon
sleep 35
echo "$(date) - Delay done (TV Ready)" >> $LOG

# Cek PM2 daemon
echo "$(date) - Checking PM2 daemon..." >> $LOG
timeout 10 pm2 ping > /dev/null 2>&1

if [ $? -ne 0 ]; then
    echo "$(date) - PM2 daemon not running, starting..." >> $LOG
    pm2 daemon
fi

# Setelah daemon aktif → resurrect
sleep 3
echo "$(date) - Running PM2 resurrect..." >> $LOG
timeout 10 pm2 resurrect

echo "$(date) - PM2 daemon started + resurrect OK" >> $LOG
