ifeq ($(OS),Windows_NT)
  PLUGINS_DIR := C:\Users\gvardal\IKSAP Projects\HRAlyze\aspnet-core\src\plugins
  DB_DIR      := C:\Kanban\db
  PUBLIC_DIR  := C:\Kanban\public
  CLAUDE_DIR  := C:\Users\gvardal\.claude
else
  PLUGINS_DIR := /home/giray/IKSAP Projects/HRAlyze/aspnet-core/src/plugins
  DB_DIR      := /home/giray/IKSAP Projects/Kanban/db
  PUBLIC_DIR  := /home/giray/IKSAP Projects/Kanban/public
  CLAUDE_DIR  := /home/giray/.claude
endif

export PLUGINS_DIR DB_DIR PUBLIC_DIR CLAUDE_DIR

up:
	docker compose up -d

down:
	docker compose down

logs:
	docker compose logs -f

restart:
	docker compose restart
