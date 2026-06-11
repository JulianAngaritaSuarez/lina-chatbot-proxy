/* ============================================================
   PROXY SEGURO — Google Gemini API para chatbot de Lina Sánchez
   ─────────────────────────────────────────────────────────────
   Despliega este servidor en Render.com (gratis).
   La API key vive en variables de entorno, nunca en el cliente.
   ============================================================ */

const express = require('express');
const app     = express();

/* ── Dominios permitidos (tu sitio en producción + local) ── */
const ALLOWED_ORIGINS = [
  'https://eleconlina.onrender.com',
  'http://localhost:3000',
  'http://localhost:5500',
  'http://127.0.0.1:5500',
];

/* ── CORS: solo acepta peticiones de tu sitio ── */
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.json({ limit: '20kb' })); // limitar tamaño del body

/* ── Rate limiting simple en memoria ── */
const rateLimitMap = new Map();
const RATE_LIMIT_MAX = 20;     // peticiones máximas
const RATE_LIMIT_WIN = 60000;  // por ventana de 60 segundos

function rateLimit(req, res, next) {
  const ip  = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress || 'unknown';
  const now = Date.now();

  if (!rateLimitMap.has(ip)) rateLimitMap.set(ip, []);
  const timestamps = rateLimitMap.get(ip).filter(t => now - t < RATE_LIMIT_WIN);
  timestamps.push(now);
  rateLimitMap.set(ip, timestamps);

  if (timestamps.length > RATE_LIMIT_MAX) {
    return res.status(429).json({ error: 'Demasiadas peticiones. Espera un momento.' });
  }
  next();
}

/* ── Limpiar el map cada 5 minutos para no acumular memoria ── */
setInterval(() => {
  const now = Date.now();
  for (const [ip, times] of rateLimitMap) {
    const fresh = times.filter(t => now - t < RATE_LIMIT_WIN);
    if (fresh.length === 0) rateLimitMap.delete(ip);
    else rateLimitMap.set(ip, fresh);
  }
}, 300000);

/* ── Modelo de Gemini a usar ── */
const GEMINI_MODEL = 'gemini-2.0-flash';

/* ── Endpoint principal ── */
app.post('/chat', rateLimit, async (req, res) => {
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    console.error('[Proxy] GEMINI_API_KEY no configurada');
    return res.status(500).json({ error: 'Configuración del servidor incompleta.' });
  }

  /* Validar que el body tenga la estructura mínima esperada */
  const { system, messages, max_tokens } = req.body;

  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'Petición inválida.' });
  }

  /* Convertir formato Anthropic-style { role: 'user'|'assistant', content } 
     al formato Gemini { role: 'user'|'model', parts: [{ text }] } */
  const contents = messages.map(m => ({
    role:  m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: String(m.content || '') }],
  }));

  const body = {
    contents,
    generationConfig: {
      maxOutputTokens: Math.min(max_tokens || 600, 800),
      temperature: 0.7,
    },
  };

  if (system) {
    body.systemInstruction = { parts: [{ text: system }] };
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const err = await response.text();
      console.error('[Proxy] Error de Gemini:', response.status, err);
      return res.status(response.status).json({ error: 'Error al contactar el asistente.' });
    }

    const data = await response.json();

    /* Extraer el texto de la respuesta de Gemini */
    const text = data?.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || '';

    /* Devolver en formato compatible con el cliente (estilo Anthropic) */
    res.json({ content: [{ type: 'text', text }] });

  } catch (err) {
    console.error('[Proxy] Error interno:', err.message);
    res.status(500).json({ error: 'Error interno del servidor.' });
  }
});

/* ── Health check (para que Render sepa que el servicio vive) ── */
app.get('/health', (req, res) => res.json({ status: 'ok', ts: Date.now() }));

/* ── Rechazar cualquier otra ruta ── */
app.use((req, res) => res.status(404).json({ error: 'Ruta no encontrada.' }));

/* ── Arrancar ── */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`[Proxy] Corriendo en puerto ${PORT} ✓`));
