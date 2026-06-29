if ($IsLinux) {
    $env:PLUGINS_DIR = "/home/giray/IKSAP Projects/HRAlyze/aspnet-core/src/plugins"
    $env:DB_DIR      = "/home/giray/IKSAP Projects/Kanban/db"
    $env:PUBLIC_DIR  = "/home/giray/IKSAP Projects/Kanban/public"
    $env:CLAUDE_DIR  = "/home/giray/.claude"
} else {
    $env:PLUGINS_DIR = "C:\Users\gvardal\IKSAP Projects\HRAlyze\aspnet-core\src\plugins"
    $env:DB_DIR      = "C:\Kanban\db"
    $env:PUBLIC_DIR  = "C:\Kanban\public"
    $env:CLAUDE_DIR  = "C:\Users\gvardal\.claude"
}

docker compose @args
