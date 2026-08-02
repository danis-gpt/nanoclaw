#!/usr/bin/env bash
set -euo pipefail

unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
repo_dir="/home/ubuntu/pr/nanoclaw1/nanoclaw-v2"

mkdir -p "$unit_dir"
cp "$repo_dir"/ops/systemd/nanoclaw-kommo-*.service "$unit_dir"/
cp "$repo_dir"/ops/systemd/nanoclaw-kommo-*.timer "$unit_dir"/

systemctl --user daemon-reload
systemctl --user enable --now nanoclaw-kommo-incremental-sync.timer
systemctl --user enable --now nanoclaw-kommo-full-sync.timer

systemctl --user list-timers 'nanoclaw-kommo-*' --no-pager
