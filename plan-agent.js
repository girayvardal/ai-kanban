/**
 * HRAlyze Kanban — Plan Agent
 *
 * Host'ta çalışır, Docker içindeki Kanban sunucusuna socket.io ile bağlanır.
 * "plan:generate" eventi geldiğinde `claude -p` ile plan üretir,
 * sonucu PUT /api/tasks/:id/plan ile kaydeder.
 *
 * Başlatmak için:
 *   node plan-agent.js
 *
 * İsteğe bağlı env:
 *   KANBAN_URL=http://localhost:3737   (varsayılan)
 *   CLAUDE_MODEL=claude-sonnet-4-6     (varsayılan)
 */

const { io } = require("socket.io-client");
const { execFile } = require("child_process");
const http = require("http");

const KANBAN_URL = process.env.KANBAN_URL || "http://localhost:3737";
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-4-6";
const MAX_CONCURRENT = 3; // aynı anda max kaç plan üretilsin

let active = 0;
const queue = [];

// ─── Socket bağlantısı ──────────────────────────────────────────────────────
const socket = io(KANBAN_URL, { reconnectionDelay: 3000 });

socket.on("connect", () => {
  console.log(`[Agent] Kanban'a bağlandı: ${KANBAN_URL} (${socket.id})`);
});

socket.on("disconnect", () => {
  console.log("[Agent] Bağlantı kesildi, yeniden bağlanılıyor...");
});

socket.on("plan:generate", (data) => {
  console.log(`[Agent] Plan üretme isteği: ${data.taskId} — ${data.module} ${data.taskNo}`);
  queue.push(data);
  processQueue();
});

// ─── Kuyruk işleme ──────────────────────────────────────────────────────────
function processQueue() {
  while (active < MAX_CONCURRENT && queue.length > 0) {
    const task = queue.shift();
    active++;
    generatePlan(task).finally(() => {
      active--;
      processQueue();
    });
  }
}

// ─── Plan üretimi ───────────────────────────────────────────────────────────
async function generatePlan(task) {
  const prompt = buildPrompt(task);
  console.log(`[Agent] Claude çağrılıyor: ${task.taskId}`);

  let content;
  try {
    content = await runClaude(prompt);
  } catch (err) {
    console.error(`[Agent] Claude hatası (${task.taskId}):`, err.message);
    return;
  }

  try {
    await putPlan(task.taskId, content);
    console.log(`[Agent] Plan kaydedildi: ${task.taskId}`);
  } catch (err) {
    console.error(`[Agent] Plan kaydetme hatası (${task.taskId}):`, err.message);
  }
}

function buildPrompt({ module, taskNo, description, imageUrls = [] }) {
  const imageSection = imageUrls.length
    ? `\n\nGöreve eklenmiş ${imageUrls.length} görsel var:\n${imageUrls.map(u => `  - ${u}`).join('\n')}\n(Görseller referans amaçlıdır, UI/tasarım detayları içerebilir.)`
    : '';

  return `Sen HRAlyze projesinin kıdemli yazılım mimarısın. \
ABP Framework 9.3, .NET 9, Angular 20 kullanan kurumsal bir İK yönetim platformu.

Aşağıdaki Kanban görevi için kısa ve uygulanabilir bir geliştirme planı oluştur.

**Modül:** ${module}
**Görev:** ${taskNo}
**Açıklama:** ${description}${imageSection}

Plan şu başlıkları içermeli (Markdown):
## Tespit / Analiz
## Yapılacaklar (adım adım)
## Dikkat Edilecekler
## Etkilenen Dosyalar (tahmini)

Kısa ve özlü yaz, maksimum 400 kelime.`;
}

function runClaude(prompt) {
  return new Promise((resolve, reject) => {
    const args = ["--model", CLAUDE_MODEL, "-p", prompt];
    execFile("claude", args, { timeout: 120_000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      resolve(stdout.trim());
    });
  });
}

// ─── HTTP PUT /api/tasks/:id/plan ───────────────────────────────────────────
function putPlan(taskId, content) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ content });
    const url = new URL(`/api/tasks/${encodeURIComponent(taskId)}/plan`, KANBAN_URL);
    const req = http.request(url, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
    }, (res) => {
      let data = "";
      res.on("data", d => data += d);
      res.on("end", () => res.statusCode < 300 ? resolve(JSON.parse(data)) : reject(new Error(`HTTP ${res.statusCode}: ${data}`)));
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

console.log(`[Agent] Başlatıldı — ${KANBAN_URL} bekleniyor...`);
