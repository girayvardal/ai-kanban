#!/bin/bash
if [[ "$OSTYPE" == "linux"* ]]; then
    export PLUGINS_DIR="/home/giray/IKSAP Projects/HRAlyze/aspnet-core/src/plugins"
    export DB_DIR="/home/giray/IKSAP Projects/Kanban/db"
    export PUBLIC_DIR="/home/giray/IKSAP Projects/Kanban/public"
    export CLAUDE_DIR="/home/giray/.claude"
else
    export PLUGINS_DIR="C:/Users/gvardal/IKSAP Projects/HRAlyze/aspnet-core/src/plugins"
    export DB_DIR="C:/Kanban/db"
    export PUBLIC_DIR="C:/Kanban/public"
    export CLAUDE_DIR="C:/Users/gvardal/.claude"
fi

docker compose "$@"
