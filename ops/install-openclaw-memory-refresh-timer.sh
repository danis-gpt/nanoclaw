#!/usr/bin/env bash
set -euo pipefail

unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
repo_dir="/home/ubuntu/pr/nanoclaw1/nanoclaw-v2"

mkdir -p "$unit_dir"
cp "$repo_dir"/ops/systemd/nanoclaw-openclaw-memory-refresh.service "$unit_dir"/
cp "$repo_dir"/ops/systemd/nanoclaw-openclaw-memory-refresh.timer "$unit_dir"/

systemctl --user daemon-reload
systemctl --user enable --now nanoclaw-openclaw-memory-refresh.timer

systemctl --user list-timers 'nanoclaw-openclaw-memory-refresh*' --no-pager
