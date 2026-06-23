const express = require("express");
const { createServer } = require("http");
const { Server } = require("socket.io");
const Database = require("better-sqlite3");
const cron = require("node-cron");
const fs = require("fs");
const path = require("path");
const { glob } = require("glob");
const multer = require("multer");

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: "*" } });

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ─── UPLOADS ────────────────────────────────────────────────────────────────
const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(path.dirname(process.env.DB_PATH || path.join(__dirname, "kanban.db")), "images");
fs.mkdirSync(UPLOADS_DIR, { recursive: true });
app.use("/uploads", express.static(UPLOADS_DIR));

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOADS_DIR),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase() || ".png";
      cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
    },
  }),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
  fileFilter: (req, file, cb) => cb(null, /^image\//.test(file.mimetype)),
});

io.on("connection", (socket) => {
  console.log("[WS] İstemci bağlandı:", socket.id);
  socket.on("disconnect", () => console.log("[WS] İstemci ayrıldı:", socket.id));
});

// ─── DB SETUP ───────────────────────────────────────────────────────────────
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "kanban.db");
const db = new Database(DB_PATH);
db.pragma("encoding = 'UTF-8'");

db.exec(`
  CREATE TABLE IF NOT EXISTS tasks (
    id          TEXT PRIMARY KEY,
    module      TEXT NOT NULL,
    task_no     TEXT NOT NULL,
    title       TEXT NOT NULL,
    description TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'todo',
    priority    INTEGER DEFAULT 0,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS sync_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    synced_at  TEXT NOT NULL DEFAULT (datetime('now')),
    added      INTEGER DEFAULT 0,
    updated    INTEGER DEFAULT 0,
    total      INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS task_plans (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id    TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    content    TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS task_images (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id    TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    filename   TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// ─── MD PARSER ──────────────────────────────────────────────────────────────
const PLUGINS_DIR = process.env.PLUGINS_DIR || "/data/plugins";

function parseYapilacaklar(filePath) {
  const raw = fs.readFileSync(filePath);
  // UTF-8 BOM (EF BB BF) veya UTF-16 BOM varsa temizle
  const content = raw[0] === 0xEF && raw[1] === 0xBB && raw[2] === 0xBF
    ? raw.slice(3).toString("utf-8")
    : raw.toString("utf-8");
  const moduleName = filePath.split(/[\\/]/).find((p, i, arr) => arr[i - 1] === "plugins") || "Bilinmeyen";
  const tasks = [];

  const lines = content.split("\n");
  let inPending = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (/##\s+Bekleyen Görevler/i.test(line)) { inPending = true; continue; }
    if (/##\s+Tamamlanan/i.test(line)) { inPending = false; continue; }

    // Hem pending hem tamamlanan bölümündeki [x] satırlarını yakala
    const isDone    = /^- \[x\]\s+\*\*(.+?)\*\*[^—–\n]*[—–-]\s*(.+)/i.test(line);
    const isPending = inPending && /^- \[ \]\s+\*\*(.+?)\*\*[^—–\n]*[—–-]\s*(.+)/.test(line);

    if (!isPending && !isDone) continue;

    const match = line.match(/^- \[[x ]\]\s+\*\*(.+?)\*\*[^—–\n]*[—–-]\s*(.+)/i);
    if (!match) continue;

    const taskNo = match[1].trim();
    let description = match[2].trim();

    // devam satırları
    while (i + 1 < lines.length) {
      const next = lines[i + 1];
      if (/^\s+\S/.test(next) || (next.trim() === "" && i + 2 < lines.length && /^\s+\S/.test(lines[i + 2]))) {
        i++;
        if (next.trim()) description += " " + next.trim();
      } else break;
    }

    tasks.push({ module: moduleName, taskNo, description, mdDone: isDone });
  }

  return tasks;
}

function makeId(module, taskNo) {
  return `${module}__${taskNo}`.replace(/\s+/g, "_");
}

async function syncFromMd() {
  let files = [];
  try {
    files = await glob(`${PLUGINS_DIR}/*/docs/features/yapilacaklar.md`);
  } catch (e) {
    console.error("Glob hatası:", e.message);
    return { added: 0, updated: 0, total: 0 };
  }

  if (files.length === 0) {
    console.warn("Hiç yapilacaklar.md bulunamadı. PLUGINS_DIR:", PLUGINS_DIR);
    return { added: 0, updated: 0, total: 0 };
  }

  let added = 0, updated = 0, total = 0;

  const insertStmt = db.prepare(`
    INSERT INTO tasks (id, module, task_no, title, description, status, priority)
    VALUES (@id, @module, @task_no, @title, @description, @status, @priority)
    ON CONFLICT(id) DO NOTHING
  `);
  const markDoneStmt = db.prepare(`
    UPDATE tasks SET status = 'done', updated_at = datetime('now')
    WHERE id = ? AND status NOT IN ('done', 'in_progress')
  `);
  // in_progress görev üzerinde çalışılıyor — MD [x] olsa bile dokunma

  const txn = db.transaction((tasks) => {
    for (const t of tasks) {
      const id = makeId(t.module, t.taskNo);
      const existing = db.prepare("SELECT id, status FROM tasks WHERE id = ?").get(id);

      if (!existing) {
        // Yeni görev — MD'deki durumunu yansıt
        insertStmt.run({
          id,
          module: t.module,
          task_no: t.taskNo,
          title: `${t.module} — ${t.taskNo}`,
          description: t.description,
          status: t.mdDone ? 'done' : 'todo',
          priority: 0,
        });
        added++;
      } else if (t.mdDone && existing.status === 'todo') {
        // MD'de [x] ama DB'de todo → done yap (in_progress'e dokunma)
        markDoneStmt.run(id);
        updated++;
      } else if (!t.mdDone && existing.status === 'done') {
        // MD'de [ ] ama DB'de done → todo'ya geri al (el ile geri alındı)
        db.prepare(`UPDATE tasks SET status = 'todo', updated_at = datetime('now') WHERE id = ?`).run(id);
        updated++;
      }
      total++;
    }
  });

  const allTasks = [];
  for (const file of files) {
    try {
      const tasks = parseYapilacaklar(file);
      allTasks.push(...tasks);
    } catch (e) {
      console.error("Parse hatası:", file, e.message);
    }
  }

  txn(allTasks);

  db.prepare("INSERT INTO sync_log (added, updated, total) VALUES (?, ?, ?)").run(added, updated, total);
  console.log(`[SYNC] ${new Date().toISOString()} — Eklenen: ${added}, Güncellenen: ${updated}, Toplam: ${total}`);
  if (added > 0 || updated > 0) io.emit("sync:done", { added, updated, total });

  // Yeni eklenen ve plansız görevler için host agent'a plan üret
  if (added > 0) {
    const newTasks = db.prepare(`
      SELECT t.* FROM tasks t
      LEFT JOIN task_plans p ON p.task_id = t.id
      WHERE p.id IS NULL AND t.status = 'todo'
      ORDER BY t.created_at DESC LIMIT ?
    `).all(added);
    for (const t of newTasks) emitPlanGenerate(t);
  }

  return { added, updated, total };
}

// ─── CRON: Her gün 08:00 ────────────────────────────────────────────────────
const CRON_SCHEDULE = process.env.CRON_SCHEDULE || "0 8 * * *";
cron.schedule(CRON_SCHEDULE, () => {
  console.log("[CRON] Sabah sync başlıyor...");
  syncFromMd();
});

// ─── API ────────────────────────────────────────────────────────────────────

// GET /api/tasks — tüm görevler (opsiyonel ?module=X&status=Y)
app.get("/api/tasks", (req, res) => {
  let query = "SELECT * FROM tasks WHERE 1=1";
  const params = [];
  if (req.query.module) { query += " AND module = ?"; params.push(req.query.module); }
  if (req.query.status) { query += " AND status = ?"; params.push(req.query.status); }
  query += " ORDER BY module, priority, created_at";
  res.json(db.prepare(query).all(...params));
});

// GET /api/modules — modül listesi
app.get("/api/modules", (req, res) => {
  const rows = db.prepare("SELECT DISTINCT module FROM tasks ORDER BY module").all();
  res.json(rows.map((r) => r.module));
});

// PATCH /api/tasks/:id — statü veya priority güncelle
app.patch("/api/tasks/:id", (req, res) => {
  const { status, priority, description } = req.body;
  const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(req.params.id);
  if (!task) return res.status(404).json({ error: "Görev bulunamadı" });

  const allowed = ["todo", "in_progress", "done"];
  if (status && !allowed.includes(status)) return res.status(400).json({ error: "Geçersiz statü" });

  db.prepare(`
    UPDATE tasks SET
      status     = COALESCE(?, status),
      priority   = COALESCE(?, priority),
      description = COALESCE(?, description),
      updated_at = datetime('now')
    WHERE id = ?
  `).run(status ?? null, priority ?? null, description ?? null, req.params.id);

  const updated = db.prepare("SELECT * FROM tasks WHERE id = ?").get(req.params.id);
  io.emit("task:updated", updated);   // tüm istemcilere anlık bildir
  res.json(updated);
});

// POST /api/tasks — manuel görev ekle
app.post("/api/tasks", (req, res) => {
  const { module, taskNo, title, description, autoPlan } = req.body;
  if (!module || !taskNo || !description) return res.status(400).json({ error: "module, taskNo, description zorunlu" });

  const id = makeId(module, taskNo);
  const existing = db.prepare("SELECT id FROM tasks WHERE id = ?").get(id);
  if (existing) return res.status(409).json({ error: "Bu görev zaten mevcut", id });

  db.prepare(`
    INSERT INTO tasks (id, module, task_no, title, description, status)
    VALUES (?, ?, ?, ?, ?, 'todo')
  `).run(id, module, taskNo, title || `${module} — ${taskNo}`, description);

  const created = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id);
  io.emit("task:updated", created);

  // Plan otomatik üretimi: autoPlan=false ile devre dışı bırakılabilir
  if (autoPlan !== false) emitPlanGenerate(created);

  res.status(201).json(created);
});

// DELETE /api/tasks/:id
app.delete("/api/tasks/:id", (req, res) => {
  db.prepare("DELETE FROM tasks WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

// GET /api/tasks/:id/plan
app.get("/api/tasks/:id/plan", (req, res) => {
  const plan = db.prepare("SELECT * FROM task_plans WHERE task_id = ?").get(req.params.id);
  res.json(plan || null);
});

// PUT /api/tasks/:id/plan — upsert
app.put("/api/tasks/:id/plan", (req, res) => {
  const { content } = req.body;
  if (!content || !content.trim()) return res.status(400).json({ error: "content zorunlu" });
  const task = db.prepare("SELECT id FROM tasks WHERE id = ?").get(req.params.id);
  if (!task) return res.status(404).json({ error: "Görev bulunamadı" });

  const existing = db.prepare("SELECT id FROM task_plans WHERE task_id = ?").get(req.params.id);
  if (existing) {
    db.prepare("UPDATE task_plans SET content = ?, updated_at = datetime('now') WHERE task_id = ?")
      .run(content.trim(), req.params.id);
  } else {
    db.prepare("INSERT INTO task_plans (task_id, content) VALUES (?, ?)").run(req.params.id, content.trim());
  }
  const saved = db.prepare("SELECT * FROM task_plans WHERE task_id = ?").get(req.params.id);
  io.emit("plan:updated", { taskId: req.params.id, plan: saved });
  res.json(saved);
});

// DELETE /api/tasks/:id/plan
app.delete("/api/tasks/:id/plan", (req, res) => {
  db.prepare("DELETE FROM task_plans WHERE task_id = ?").run(req.params.id);
  io.emit("plan:updated", { taskId: req.params.id, plan: null });
  res.json({ ok: true });
});

// POST /api/tasks/:id/plan/generate — host agent'a plan ürettir
app.post("/api/tasks/:id/plan/generate", (req, res) => {
  const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(req.params.id);
  if (!task) return res.status(404).json({ error: "Görev bulunamadı" });
  const existingPlan = db.prepare("SELECT id FROM task_plans WHERE task_id = ?").get(task.id);
  if (existingPlan) return res.status(409).json({ error: "Plan zaten mevcut" });
  emitPlanGenerate(task);
  res.json({ ok: true, message: "Plan üretimi başlatıldı" });
});

function emitPlanGenerate(task) {
  const images = db.prepare("SELECT filename FROM task_images WHERE task_id = ? ORDER BY created_at").all(task.id);
  const imageUrls = images.map(i => `http://localhost:3737/uploads/${i.filename}`);
  io.emit("plan:generate", { taskId: task.id, module: task.module, taskNo: task.task_no, description: task.description, imageUrls });
  io.emit("plan:generating", { taskId: task.id });
}

// GET /api/tasks/:id/images
app.get("/api/tasks/:id/images", (req, res) => {
  res.json(db.prepare("SELECT * FROM task_images WHERE task_id = ? ORDER BY created_at").all(req.params.id));
});

// POST /api/tasks/:id/images — resim yükle
app.post("/api/tasks/:id/images", upload.single("image"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Resim bulunamadı" });
  const task = db.prepare("SELECT id FROM tasks WHERE id = ?").get(req.params.id);
  if (!task) { fs.unlinkSync(req.file.path); return res.status(404).json({ error: "Görev bulunamadı" }); }
  const row = db.prepare("INSERT INTO task_images (task_id, filename) VALUES (?, ?)").run(req.params.id, req.file.filename);
  const saved = db.prepare("SELECT * FROM task_images WHERE id = ?").get(row.lastInsertRowid);
  io.emit("images:updated", { taskId: req.params.id });
  res.status(201).json(saved);
});

// DELETE /api/tasks/:id/images/:imageId
app.delete("/api/tasks/:id/images/:imageId", (req, res) => {
  const img = db.prepare("SELECT * FROM task_images WHERE id = ? AND task_id = ?").get(req.params.imageId, req.params.id);
  if (!img) return res.status(404).json({ error: "Resim bulunamadı" });
  try { fs.unlinkSync(path.join(UPLOADS_DIR, img.filename)); } catch {}
  db.prepare("DELETE FROM task_images WHERE id = ?").run(img.id);
  io.emit("images:updated", { taskId: req.params.id });
  res.json({ ok: true });
});

// POST /api/sync — manuel tetikleme
app.post("/api/sync", async (req, res) => {
  const result = await syncFromMd();
  res.json(result);
});

// GET /api/sync/log
app.get("/api/sync/log", (req, res) => {
  res.json(db.prepare("SELECT * FROM sync_log ORDER BY id DESC LIMIT 20").all());
});

// ─── BOOT ───────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3737;
httpServer.listen(PORT, async () => {
  console.log(`HRAlyze Kanban → http://localhost:${PORT}`);
  console.log("İlk sync başlıyor...");
  await syncFromMd();
});
