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
  const nowSP = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Sao_Paulo" }));
  const start = new Date(nowSP);
  start.setHours(0, 0, 0, 0);
  const end = new Date(nowSP);
  const daysUntilSunday = 7 - nowSP.getDay();
  end.setDate(nowSP.getDate() + daysUntilSunday);
  end.setHours(23, 59, 59, 999);

  const params = new URLSearchParams({
    timeMin: start.toISOString(),
    timeMax: end.toISOString(),
    singleEvents: 'true',
    orderBy: 'startTime',
    maxResults: '20'
  });

  const res = await httpsRequest({
    hostname: 'www.googleapis.com',
    path: '/calendar/v3/calendars/primary/events?' + params,
    method: 'GET',
    headers: { 'Authorization': 'Bearer ' + token }
  });

  const data = JSON.parse(res.body);
  if (!data.items || data.items.length === 0) return 'nenhum evento esta semana';

  const byDay = {};
  data.items.forEach(e => {
    const d = e.start.dateTime || e.start.date;
    const day = new Date(d).toLocaleDateString('pt-BR', { weekday: 'short', day: 'numeric', timeZone: 'America/Sao_Paulo' });
    if (!byDay[day]) byDay[day] = [];
    const t = e.start.dateTime
      ? new Date(e.start.dateTime).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' })
      : 'dia todo';
    byDay[day].push(t + ' ' + e.summary);
  });
  return Object.entries(byDay).map(([day, evs]) => day + ': ' + evs.join(', ')).join(' | ');
}

// ─── GMAIL ───────────────────────────────────────────────────────────────────
async function getUnreadEmails(token) {
  // Busca não lidos
  const resUnread = await httpsRequest({
    hostname: 'gmail.googleapis.com',
    path: '/gmail/v1/users/me/messages?q=is:unread+is:inbox&maxResults=5',
    method: 'GET',
    headers: { 'Authorization': 'Bearer ' + token }
  });

  // Busca lidos mas sem resposta nos últimos 7 dias
  const resPending = await httpsRequest({
    hostname: 'gmail.googleapis.com',
    path: '/gmail/v1/users/me/messages?q=is:read+is:inbox+-in:sent+newer_than:7d&maxResults=5',
    method: 'GET',
    headers: { 'Authorization': 'Bearer ' + token }
  });

  async function fetchHeaders(msgId) {
    const d = await httpsRequest({
      hostname: 'gmail.googleapis.com',
      path: '/gmail/v1/users/me/messages/' + msgId + '?format=metadata&metadataHeaders=Subject&metadataHeaders=From',
      method: 'GET',
      headers: { 'Authorization': 'Bearer ' + token }
    });
    const p = JSON.parse(d.body);
    const h = (p.payload && p.payload.headers) || [];
    const subject = (h.find(x => x.name === 'Subject') || {}).value || '(sem assunto)';
    const from = ((h.find(x => x.name === 'From') || {}).value || '').replace(/<.*>/, '').trim();
    return (from || 'desconhecido') + ': ' + subject;
  }

  const unreadData = JSON.parse(resUnread.body);
  const pendingData = JSON.parse(resPending.body);

  const unreadMsgs = unreadData.messages || [];
  const pendingMsgs = pendingData.messages || [];

  let result = '';

  if (unreadMsgs.length > 0) {
    const emails = await Promise.all(unreadMsgs.slice(0, 3).map(m => fetchHeaders(m.id)));
    result += `${unreadData.resultSizeEstimate || unreadMsgs.length} nao lidos: ${emails.join('; ')}`;
  } else {
    result += 'nenhum nao lido';
  }

  if (pendingMsgs.length > 0) {
    const emails = await Promise.all(pendingMsgs.slice(0, 3).map(m => fetchHeaders(m.id)));
    result += ` | pendentes sem resposta: ${emails.join('; ')}`;
  }

  return result || 'sem pendencias';
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
    .slice(0, 900);
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

RETORNE APENAS UM JSON VALIDO com exatamente 3 campos, sem texto fora do JSON:
{
  "agenda": "[eventos de hoje com horario, ou 'Sem eventos hoje']",
  "emails": "[resumo dos emails nao lidos, ou 'Sem pendencias']",
  "prioridade": "[1 insight pratico + 1 acao concreta para hoje como SE Botmaker, maximo 200 chars]"
}

Regras: texto plano, SEM emojis, SEM asteriscos, maximo 200 chars por campo.`,

    
    weekly: `Hoje e ${now}. Gere planejamento semanal do Bernard Prado, Sales Engineer Senior Botmaker Brasil.

EVENTOS DA SEMANA: ${calendar}
EMAILS PENDENTES: ${gmail}

RETORNE APENAS UM JSON VALIDO com exatamente 3 campos, sem texto fora do JSON:
{
  "agenda": "[eventos agrupados por dia seg-sex com horarios, maximo 250 chars]",
  "emails": "[emails pendentes relevantes, ou 'Sem pendencias']",
  "prioridade": "[top 3 acoes da semana numeradas, maximo 250 chars]"
}

Regras: texto plano, SEM emojis, SEM asteriscos, maximo 250 chars por campo.`,
    night: `Hoje e ${now}. Gere check-in noturno do Bernard Prado, Sales Engineer Senior Botmaker Brasil.

AGENDA DO DIA: ${calendar}
EMAILS PENDENTES: ${gmail}

RETORNE APENAS UM JSON VALIDO com exatamente 3 campos, sem texto fora do JSON:
{
  "agenda": "[resumo do que aconteceu hoje, ou 'Dia sem eventos']",
  "emails": "[emails pendentes se houver, ou 'Sem pendencias']",
  "prioridade": "[1 acao concreta para comecar amanha + 1 lembrete, maximo 200 chars]"
}

Regras: texto plano, SEM emojis, SEM asteriscos, maximo 200 chars por campo.`
  };

  if (!prompts[mode]) throw new Error('Modo invalido: ' + mode);
  const raw = await callAnthropic(prompts[mode]);
  try {
    const clean = raw.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(clean);
    return {
      agenda: sanitize(parsed.agenda || 'a confirmar'),
      emails: sanitize(parsed.emails || 'a confirmar'),
      prioridade: sanitize(parsed.prioridade || 'a confirmar')
    };
  } catch(e) {
    console.error('JSON parse falhou:', raw);
    return { agenda: sanitize(raw).slice(0, 200), emails: 'a confirmar', prioridade: 'a confirmar' };
  }
}

// ─── TELEGRAM ────────────────────────────────────────────────────────────────
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;

async function sendTelegram(chatId, text) {
  await httpsRequest({
    hostname: 'api.telegram.org',
    path: `/bot${TELEGRAM_TOKEN}/sendMessage`,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  }, { chat_id: chatId, text: text });
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

    // Endpoint /telegram
    if (url.pathname === '/telegram') {
      res.writeHead(200);
      res.end('OK');
      try {
        const payload = JSON.parse(body || '{}');
        const message = payload.message;
        if (!message || !message.text) return;
        const chatId = message.chat.id;
        const text = message.text;
        const sender = message.from?.first_name || 'unknown';
        console.log('[telegram] de ' + sender + ': ' + text);

        const response = await fetch(OPENCLAW_URL + '/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + OPENCLAW_TOKEN,
            'ngrok-skip-browser-warning': 'true'
          },
          body: JSON.stringify({
            model: 'openclaw/main',
            stream: false,
            messages: [{ role: 'user', content: text }],
            user: String(chatId)
          })
        });

        const data = await response.json();
        const reply = data.choices?.[0]?.message?.content || 'Processado.';
        await sendTelegram(chatId, reply);
      } catch (err) {
        console.error('[telegram] erro:', err.message);
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
