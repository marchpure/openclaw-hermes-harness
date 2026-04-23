#!/bin/bash
set -e

PLUGIN_NAME="openclaw-plugin-hermes"
CURRENT_DIR=$(pwd)
EXT_DIR="$HOME/.openclaw/extensions/$PLUGIN_NAME"

mkdir -p "$EXT_DIR"
rm -rf "$EXT_DIR"/*

cp -r src "$EXT_DIR/"
cp openclaw.plugin.json "$EXT_DIR/"
cp package.json "$EXT_DIR/"
cp tsconfig.json "$EXT_DIR/"

cd "$EXT_DIR"
npm install --omit=dev

echo "✅ Plugin installed to $EXT_DIR"
