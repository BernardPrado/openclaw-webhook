const http = require('http');
const https = require('https');
const PORT = process.env.PORT || 3000;
const OPENCLAW_URL = process.env.OPENCLAW_URL || 'https://smokiness-dense-stooge.ngrok-free.dev';
const OPENCLAW_TOKEN = process.env.OPENCLAW_TOKEN || '167c88d60fc75a0f9acc9569477edb5fbb881e5345531356';

const GOOGLE_CLIENT_ID     = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN;
const ANTHROPIC_API_KEY    = process.env.ANTHROPIC_API_KEY;

// ─── HTTP helper ─────────────────────────────────────────────────────────────
function httpsRequest(options, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? (typeof body === 'string' ? body : JSON.stringify(body)) : null;
    if (payload) {
      options.headers = options.headers || {};
      options.headers['Content-Length'] = Buffer.byteLength(payload);
    }
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// ─── GOOGLE: access token ─────────────────────────────────────────────────────
async function getAccessToken() {
  const body = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    client_secret: GOOGLE_CLIENT_SECRET,
    refresh_token: GOOGLE_REFRESH_TOKEN,
    grant_type: 'refresh_token'
  }).toString();

  const res = await httpsRequest({
    hostname: 'oauth2.googleapis.com',
    path: '/token',
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
  }, body);

  const data = JSON.parse(res.body);
  if (!data.access_token) throw new Error('Token Google falhou: ' + res.body);
  return data.access_token;
}

// ─── GOOGLE CALENDAR ─────────────────────────────────────────────────────────
async function getCalendarEvents(token) {
  const now = new Date();
  const end = new Date(); end.setHours(23, 59, 59, 999);
  const params = new URLSearchParams({
    timeMin: now.toISOString(),
    timeMax: end.toISOString(),
    singleEvents: 'true',
    orderBy: 'startTime',
    maxResults: '8'
  });

  const res = await httpsRequest({
    hostname: 'www.googleapis.com',
    path: '/calendar/v3/calendars/primary/events?' + params,
    method: 'GET',
    headers: { 'Authorization': 'Bearer ' + token }
  });

  const data = JSON.parse(res.body);
  if (!data.items || data.items.length === 0) return 'nenhum evento hoje';

  return data.items.map(e => {
    const t = e.start.dateTime
      ? new Date(e.start.dateTime).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' })
      : 'dia todo';
    return t + ' ' + e.summary;
  }).join(', ');
}

// ─── GMAIL ───────────────────────────────────────────────────────────────────
async function getUnreadEmails(token) {
  const res = await httpsRequest({
    hostname: 'gmail.googleapis.com',
    path: '/gmail/v1/users/me/messages?q=is:unread+is:inbox&maxResults=5',
    method: 'GET',
    headers: { 'Authorization': 'Bearer ' + token }
  });

  const data = JSON.parse(res.body);
  if (!data.messages || data.messages.length === 0) return 'nenhum email nao lido';

  const emails = await Promise.all(data.messages.slice(0, 5).map(async msg => {
    const d = await httpsRequest({
      hostname: 'gmail.googleapis.com',
      path: '/gmail/v1/users/me/messages/' + msg.id + '?format=metadata&metadataHeaders=Subject&metadataHeaders=From',
      method: 'GET',
      headers: { 'Authorization': 'Bearer ' + token }
    });
    const p = JSON.parse(d.body);
    const h = (p.payload && p.payload.headers) || [];
    const subject = (h.find(x => x.name === 'Subject') || {}).value || '(sem assunto)';
    const from = ((h.find(x => x.name === 'From') || {}).value || '').replace(/<.*>/, '').trim();
    return (from || 'desconhecido') + ': ' + subject;
  }));

  return (data.resultSizeEstimate || emails.length) + ' nao lidos. ' + emails.join('; ');
}

// ─── ANTHROPIC ───────────────────────────────────────────────────────────────
async function callAnthropic(prompt) {
  const res = await httpsRequest({
    hostname: 'api.anthropic.com',
    path: '/v1/messages',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    }
  }, { model: 'claude-haiku-4-5-20251001', max_tokens: 512, messages: [{ role: 'user', content: prompt }] });

  const parsed = JSON.parse(res.body);
  if (!parsed.content || !parsed.content[0]) throw new Error('Anthropic: ' + res.body);
  return parsed.content[0].text;
}

// ─── SANITIZA ────────────────────────────────────────────────────────────────
function sanitize(text) {
  return text
    .normalize('NFC')
    .replace(/[^\x00-\x7F\u00C0-\u024F]/g, '')
    .replace(/[*_~`#]/g, '')
    .replace(/\n+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, 700);
}

// ─── BRIEFING ────────────────────────────────────────────────────────────────
async function generateBriefing(mode) {
  const now = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  let calendar = 'sem acesso';
  let gmail = 'sem acesso';

  try {
    const token = await getAccessToken();
    [calendar, gmail] = await Promise.all([
      getCalendarEvents(token),
      getUnreadEmails(token)
    ]);
  } catch (err) {
    console.error('Google APIs erro:', err.message);
  }

  const prompts = {
    morning: `Hoje e ${now}. Gere briefing matinal do Bernard Prado, Sales Engineer Senior Botmaker Brasil.

AGENDA: ${calendar}
EMAILS NAO LIDOS: ${gmail}

REGRAS: texto plano, SEM emojis, SEM asteriscos, SEM markdown, maximo 700 caracteres, secoes separadas por "SECAO: texto".

Estrutura: BOM DIA: [dia e data]. AGENDA: [eventos reais ou "sem eventos hoje"]. EMAILS: [resumo real ou "sem pendencias"]. FOCO: [1 insight pratico para SE Botmaker]. DICA: [1 acao concreta para hoje].`,

    night: `Hoje e ${now}. Gere check-in noturno do Bernard Prado, Sales Engineer Senior Botmaker Brasil.

AGENDA DO DIA: ${calendar}
EMAILS PENDENTES: ${gmail}

REGRAS: texto plano, SEM emojis, SEM asteriscos, SEM markdown, maximo 600 caracteres, secoes separadas por "SECAO: texto".

Estrutura: CHECK-IN: [dia e data]. DIA: [1 frase direta sobre o dia]. EMAILS: [pendencias se houver]. AMANHA: [2 lembretes uteis]. PRIORIDADE: [1 acao para comecar amanha].`
  };

  if (!prompts[mode]) throw new Error('Modo invalido: ' + mode);
  const text = await callAnthropic(prompts[mode]);
  return sanitize(text);
}

// ─── SERVER ──────────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  if (req.method === 'GET') { res.writeHead(200); res.end('OK'); return; }

  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', async () => {
    const url = new URL(req.url, 'http://localhost');

    // Endpoint /briefing
    if (url.pathname === '/briefing') {
      try {
        const payload = JSON.parse(body || '{}');
        const mode = payload.mode || 'morning';
        console.log('[briefing] modo:', mode);
        const text = await generateBriefing(mode);
        console.log('[briefing] texto:', text);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ text }));
      } catch (err) {
        console.error('[briefing] erro:', err.message);
        res.writeHead(500);
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    // Proxy OpenClaw (comportamento original)
    try {
      const payload = JSON.parse(body);
      const message = payload.messages?.[0]?.text || payload.text || body;
      const sender = payload.messages?.[0]?.from || payload.from || 'unknown';
      console.log('Msg de ' + sender + ': ' + message);

      const response = await fetch(OPENCLAW_URL + '/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + OPENCLAW_TOKEN,
          'ngrok-skip-browser-warning': 'true'
        },
        body: JSON.stringify({ model: 'openclaw/main', stream: false, messages: [{ role: 'user', content: message }], user: sender })
      });

      const data = await response.json();
      const reply = data.choices?.[0]?.message?.content || 'Processado.';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ text: reply }));
    } catch (err) {
      console.error('Erro:', err.message);
      res.writeHead(500);
      res.end('Erro: ' + err.message);
    }
  });
});

server.listen(PORT, () => console.log('Webhook rodando na porta ' + PORT));
