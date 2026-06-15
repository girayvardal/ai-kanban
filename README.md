# AI Kanban

HRAlyze projesi için AI destekli Kanban panosu. Görevleri plugin klasörlerindeki `.md` dosyalarından otomatik olarak içe aktarır, Socket.io ile gerçek zamanlı güncelleme yapar ve Claude CLI aracılığıyla her görev için yapay zeka plan üretir.

## Özellikler

- **Otomatik senkronizasyon** — Plugin klasörlerindeki Markdown dosyalarından görevleri tarar ve içe aktarır (saatlik cron)
- **AI Plan Üretici** — Bir göreve tıklayarak Claude ile anında uygulama planı oluşturur
- **Gerçek zamanlı** — Socket.io ile tüm istemciler anlık güncelleme alır
- **Görsel Kanban** — Todo / In Progress / Done sütunları, öncelik ve modül bazlı filtreleme
- **Resim yükleme** — Görevlere görsel eklenebilir (max 10 MB)
- **SQLite** — Hafif, bağımlılıksız kalıcı depolama

## Mimari

```
┌─────────────────────┐     Socket.io      ┌──────────────────────┐
│   Browser (UI)      │ ◄────────────────► │   Kanban Server      │
│   public/index.html │                    │   server.js          │
└─────────────────────┘                    │   Express + SQLite   │
                                           └──────────┬───────────┘
                                                      │ plan:generate
                                           ┌──────────▼───────────┐
                                           │   Plan Agent         │
                                           │   plan-agent.js      │
                                           │   claude -p (CLI)    │
                                           └──────────────────────┘
```

## Kurulum

### Docker ile (önerilen)

```bash
docker compose up -d
```

`docker-compose.yml` içindeki volume yollarını kendi ortamınıza göre güncelleyin:

```yaml
- C:\IKSAP Projects\HRAlyze\aspnet-core\src\plugins:/data/plugins:ro
- C:/Kanban/db:/db
- C:/Kanban/public:/app/public:ro
```

### Manuel

```bash
npm install
npm start          # Kanban sunucusu — http://localhost:3737
npm run agent      # Plan ajanı (ayrı terminalde)
```

## Ortam Değişkenleri

| Değişken | Varsayılan | Açıklama |
|---|---|---|
| `PORT` | `3737` | Sunucu portu |
| `DB_PATH` | `./kanban.db` | SQLite veritabanı yolu |
| `PLUGINS_DIR` | — | Taranacak Markdown klasörü |
| `CRON_SCHEDULE` | `0 * * * *` | Senkronizasyon zamanlaması |
| `KANBAN_URL` | `http://localhost:3737` | Plan ajanının bağlandığı adres |
| `CLAUDE_MODEL` | `claude-sonnet-4-6` | AI plan üretiminde kullanılacak model |

## Plan Ajanı

Plan ajanı, Kanban sunucusuna Socket.io ile bağlanır. Arayüzden bir görev için plan üretme isteği geldiğinde `claude -p` komutuyla Claude CLI'yi çalıştırır ve sonucu göreve kaydeder.

Plan ajanının çalışabilmesi için host makinede Claude CLI kurulu ve authenticate edilmiş olması gerekir:

```bash
claude auth login
```

## Teknolojiler

- **Backend:** Node.js, Express, Socket.io, better-sqlite3, node-cron
- **Frontend:** Vanilla JS, HTML/CSS
- **AI:** Claude CLI (claude-sonnet-4-6)
- **Altyapı:** Docker, Docker Compose
