const http = require('http');
const PORT = process.env.PORT || 3000;
const OPENCLAW_URL = process.env.OPENCLAW_URL || 'https://smokiness-dense-stooge.ngrok-free.dev';
const OPENCLAW_TOKEN = process.env.OPENCLAW_TOKEN || '167c88d60fc75a0f9acc9569477edb5fbb881e5345531356';

const server = http.createServer(async (req, res) => {
  if (req.method !== 'POST') { res.writeHead(200); res.end('OK'); return; }
  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', async () => {
    try {
      const payload = JSON.parse(body);
      const message = payload.messages && payload.messages[0] ? payload.messages[0].text : payload.text || body;
      const sender = payload.messages && payload.messages[0] ? payload.messages[0].from : payload.from || 'unknown';
      console.log('Msg de ' + sender + ': ' + message);

      const response = await fetch(OPENCLAW_URL + '/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + OPENCLAW_TOKEN
        },
        body: JSON.stringify({
          model: 'openclaw/main',
          stream: false,
          messages: [{ role: 'user', content: message }],
          user: sender
        })
      });

      const data = await response.json();
      const reply = data.choices && data.choices[0] ? data.choices[0].message.content : 'Processado.';
      console.log('Resposta: ' + reply);
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