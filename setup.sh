#!/data/data/com.termux/files/usr/bin/bash

pkg update -y
pkg upgrade -y
pkg install nodejs git -y
npm install pm2 -g

termux-setup-storage
sleep 3

cp ~/storage/downloads/tvagent.js ~/
mkdir -p ~/.termux/boot
cp ~/storage/downloads/start-sshd ~/.termux/boot/start-sshd
chmod 700 ~/.termux/boot/start-sshd

cd ~/
npm install ws axios

pm2 start tvagent.js --name tvagent
pm2 save
pm2 daemon
