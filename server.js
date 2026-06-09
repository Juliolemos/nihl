const http = require("http");
const https = require("https");
const url = require("url");

const PORT = process.env.PORT || 3000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
const NEOTA_HOST = "rc-eucs.neotalogic.com";
const NEOTA_PATH = "/a/7333?japi=true";

const SYSTEM_PROMPT = `You are a legal intake assistant specialising in Noise-Induced Hearing Loss (NIHL) compensation claims in the UK.

You conduct a structured evidence-gathering interview, then call the call_nihl_api tool to get a deterministic ruling from the Neota rules engine. You MUST ALWAYS call the tool to get a ruling — you must never attempt to determine the outcome yourself. The tool is the only source of truth. If the tool returns an error, tell the user it is unavailable and stop.

## ADF LOGIC MAP (for guiding questions only — never for ruling)

ROOT succeeds if ALL THREE:
1. degreeOfImpairment: reliable hearing test (testsubjective and testobjective OK) + dB above threshold + correct frequency profile
2. degreeOfNoiseExposure: occupation + workingperiod established + noiseimmissionlevelc above 85dB + noiseduration sufficient + noisestatus established + employer breached duty (any of: employeetoldofrisk=false, protectionzone=false, healthsurveillance=false, riskassessment=false, earprotection=false)
3. natureOfLoss: typeofhearingloss=sensorineural + medicalcauses=none + age not primary cause + practicaldamages=true

## INTERVIEW APPROACH
- Ask 1-2 plain-English questions at a time. Briefly explain why each matters.
- Collect in this order: occupation → workingperiod → noiseimmissionlevelc/noiseduration/noisestatus → typeofhearingloss → practicaldamages → employer duty breaches → test reliability → other causes
- When you have 5+ inputs, call the tool. Use "" for any unknown inputs, "true" or "false" for known ones (as strings).
- After each tool result: if incomplete=true, explain which branches need more evidence and continue. If root=true, congratulate and advise next steps. If root=false and complete, explain which branch failed.
- Keep calling the tool as new answers arrive — never guess the outcome.
- Warm, jargon-free tone throughout. This person may be anxious.`;

const NIHL_TOOL = {
  type: "custom",
  name: "call_nihl_api",
  description: "Calls the NIHL deterministic rules engine. MUST be called for every ruling — never reason about the outcome yourself. Pass all known inputs as strings 'true'/'false'; use empty string for unknowns.",
  input_schema: {
    type: "object",
    properties: {
      workingperiod:        { type: "string", description: "true/false/'' — working period with noisy employer established" },
      medicalcauses:        { type: "string", description: "true/false/'' — other medical cause of hearing loss present" },
      healthsurveillance:   { type: "string", description: "true/false/'' — employer provided health/hearing surveillance" },
      testsubjective:       { type: "string", description: "true/false/'' — subjective test reliability issues present" },
      protectionzone:       { type: "string", description: "true/false/'' — employer provided noise protection zones/signs" },
      noiseimmissionlevelc: { type: "string", description: "true/false/'' — noise level above threshold (85dB+)" },
      typeofhearingloss:    { type: "string", description: "true/false/'' — sensorineural hearing loss confirmed" },
      noiseduration:        { type: "string", description: "true/false/'' — noise exposure duration sufficient (>1h regularly)" },
      noisestatus:          { type: "string", description: "true/false/'' — noise type established (continuous/fluctuating/intermittent/impulsive)" },
      earprotection:        { type: "string", description: "true/false/'' — adequate ear protection was provided by employer" },
      riskassessment:       { type: "string", description: "true/false/'' — employer conducted a noise risk assessment" },
      age:                  { type: "string", description: "true/false/'' — age-related hearing loss is a primary factor" },
      frequencydegree:      { type: "string", description: "true/false/'' — frequency profile consistent with NIHL" },
      employeetoldofrisk:   { type: "string", description: "true/false/'' — employee was informed of noise risks and trained" },
      testobjective:        { type: "string", description: "true/false/'' — objective test reliability issues present" },
      occupation:           { type: "string", description: "true/false/'' — occupation in noisy environment established" },
      practicaldamages:     { type: "string", description: "true/false/'' — hearing loss causes practical disability in daily life" }
    },
    required: []
  }
};

function neotaRequest(inputs) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ inputs, outputs: ["incomplete", "report", "root"] });
    const opts = {
      hostname: NEOTA_HOST,
      path: NEOTA_PATH,
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }
    };
    const req = https.request(opts, res => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error("Neota parse error: " + data.slice(0, 100))); }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function anthropicRequest(messages, onChunk) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 1000,
      system: SYSTEM_PROMPT,
      tools: [NIHL_TOOL],
      messages
    });
    const opts = {
      hostname: "api.anthropic.com",
      path: "/v1/messages",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "Content-Length": Buffer.byteLength(body)
      }
    };
    const req = https.request(opts, res => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error("Anthropic parse error")); }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function runNIHLLoop(messages) {
  let collectedInputs = {
    workingperiod:"", medicalcauses:"", healthsurveillance:"", testsubjective:"",
    protectionzone:"", noiseimmissionlevelc:"", typeofhearingloss:"", noiseduration:"",
    noisestatus:"", earprotection:"", riskassessment:"", age:"",
    frequencydegree:"", employeetoldofrisk:"", testobjective:"", occupation:"", practicaldamages:""
  };
  let lastApiResult = null;

  while (true) {
    const response = await anthropicRequest(messages);
    if (response.error) throw new Error(response.error.message);

    messages.push({ role: "assistant", content: response.content });

    if (response.stop_reason === "tool_use") {
      const toolUse = response.content.find(b => b.type === "tool_use" && b.name === "call_nihl_api");
      if (toolUse) {
        Object.assign(collectedInputs, toolUse.input);
        let toolResult;
        try {
          const apiData = await neotaRequest(collectedInputs);
          lastApiResult = apiData;
          const rootVal = apiData.outputs?.root ?? apiData.root;
          const incVal = apiData.outputs?.incomplete ?? apiData.incomplete;
          const reportVal = apiData.outputs?.report ?? apiData.report;
          toolResult = JSON.stringify({ root: rootVal, incomplete: incVal, report: reportVal });
        } catch(e) {
          toolResult = JSON.stringify({
            error: "NIHL API unreachable: " + e.message,
            instruction: "Tell the user the rules engine is unavailable. Do NOT attempt to determine the outcome yourself."
          });
        }
        messages.push({
          role: "user",
          content: [{ type: "tool_result", tool_use_id: toolUse.id, content: toolResult }]
        });
        continue;
      }
    }

    const text = (response.content || []).filter(b => b.type === "text").map(b => b.text).join("");
    let apiResult = null;
    if (lastApiResult) {
      apiResult = {
        root: lastApiResult.outputs?.root ?? lastApiResult.root,
        incomplete: lastApiResult.outputs?.incomplete ?? lastApiResult.incomplete
      };
      lastApiResult = null;
    }
    return { text, apiResult, messages };
  }
}

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>NIHL Evidence Advisor</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500&family=Lora:wght@500&display=swap" rel="stylesheet">
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  :root {
    --ink: #1a1a2e;
    --ink-mid: #4a4a6a;
    --ink-faint: #9898b0;
    --rule: #e8e8f0;
    --bg: #f7f7fb;
    --bg-card: #ffffff;
    --accent: #2d5be3;
    --accent-light: #eef2fd;
    --success: #1a7a4a;
    --success-light: #edf7f2;
    --warning: #8a5a00;
    --warning-light: #fdf6e8;
    --danger: #b02020;
    --danger-light: #fdf0f0;
    --user-bg: #eef2fd;
    --radius: 12px;
    --radius-sm: 8px;
  }

  body {
    font-family: 'Inter', sans-serif;
    background: var(--bg);
    color: var(--ink);
    min-height: 100vh;
    display: flex;
    flex-direction: column;
  }

  header {
    background: var(--bg-card);
    border-bottom: 1px solid var(--rule);
    padding: 0 24px;
    height: 56px;
    display: flex;
    align-items: center;
    gap: 12px;
    position: sticky;
    top: 0;
    z-index: 10;
  }

  .header-icon {
    width: 32px;
    height: 32px;
    background: var(--accent);
    border-radius: 8px;
    display: flex;
    align-items: center;
    justify-content: center;
    color: white;
    font-size: 16px;
    flex-shrink: 0;
  }

  .header-title {
    font-family: 'Lora', serif;
    font-size: 17px;
    font-weight: 500;
    color: var(--ink);
    letter-spacing: -0.01em;
  }

  .header-badge {
    margin-left: auto;
    font-size: 11px;
    font-weight: 500;
    color: var(--accent);
    background: var(--accent-light);
    padding: 3px 8px;
    border-radius: 99px;
    letter-spacing: 0.02em;
    text-transform: uppercase;
  }

  .progress-track {
    height: 2px;
    background: var(--rule);
    position: sticky;
    top: 56px;
    z-index: 9;
  }

  .progress-fill {
    height: 100%;
    background: var(--accent);
    transition: width 0.5s ease;
    width: 0%;
  }

  main {
    flex: 1;
    max-width: 720px;
    width: 100%;
    margin: 0 auto;
    padding: 24px 16px 120px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .msg { display: flex; gap: 10px; align-items: flex-start; }
  .msg.user { flex-direction: row-reverse; }

  .avatar {
    width: 32px;
    height: 32px;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 14px;
    flex-shrink: 0;
    border: 1px solid var(--rule);
    background: var(--bg-card);
    color: var(--ink-mid);
  }

  .msg.assistant .avatar { background: var(--accent); color: white; border-color: var(--accent); }

  .bubble {
    padding: 12px 16px;
    border-radius: var(--radius);
    font-size: 14px;
    line-height: 1.7;
    max-width: 82%;
    color: var(--ink);
  }

  .msg.assistant .bubble {
    background: var(--bg-card);
    border: 1px solid var(--rule);
    border-top-left-radius: 4px;
  }

  .msg.user .bubble {
    background: var(--user-bg);
    border: 1px solid #d4ddfb;
    border-top-right-radius: 4px;
    color: var(--accent);
  }

  .yn-row { display: flex; gap: 8px; margin-top: 10px; flex-wrap: wrap; }

  .yn-btn {
    padding: 6px 20px;
    border-radius: 99px;
    border: 1px solid var(--rule);
    background: var(--bg);
    color: var(--ink-mid);
    font-size: 13px;
    font-family: 'Inter', sans-serif;
    cursor: pointer;
    transition: all 0.15s;
  }

  .yn-btn:hover { border-color: var(--accent); color: var(--accent); background: var(--accent-light); }
  .yn-btn.yes { border-color: #b8d4c0; color: var(--success); }
  .yn-btn.yes:hover { background: var(--success-light); }
  .yn-btn.no { border-color: #f0b8b8; color: var(--danger); }
  .yn-btn.no:hover { background: var(--danger-light); }
  .yn-btn:disabled { opacity: 0.4; cursor: not-allowed; }

  .pill {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 4px 10px;
    border-radius: 99px;
    font-size: 12px;
    font-weight: 500;
    margin-top: 8px;
  }

  .pill.success { background: var(--success-light); color: var(--success); }
  .pill.incomplete { background: var(--warning-light); color: var(--warning); }
  .pill.fail { background: var(--danger-light); color: var(--danger); }

  .thinking { color: var(--ink-faint); font-style: italic; font-size: 13px; }

  .input-dock {
    position: fixed;
    bottom: 0;
    left: 0;
    right: 0;
    background: var(--bg-card);
    border-top: 1px solid var(--rule);
    padding: 12px 16px 16px;
    z-index: 10;
  }

  .input-inner {
    max-width: 720px;
    margin: 0 auto;
    display: flex;
    gap: 8px;
    align-items: flex-end;
  }

  textarea {
    flex: 1;
    padding: 10px 14px;
    border-radius: var(--radius-sm);
    border: 1px solid var(--rule);
    background: var(--bg);
    color: var(--ink);
    font-family: 'Inter', sans-serif;
    font-size: 14px;
    resize: none;
    outline: none;
    line-height: 1.5;
    min-height: 42px;
    max-height: 120px;
    transition: border-color 0.15s;
  }

  textarea:focus { border-color: var(--accent); background: var(--bg-card); }

  #send-btn {
    width: 42px;
    height: 42px;
    border-radius: var(--radius-sm);
    border: none;
    background: var(--accent);
    color: white;
    font-size: 18px;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    transition: opacity 0.15s;
  }

  #send-btn:disabled { opacity: 0.35; cursor: not-allowed; }
  #send-btn:hover:not(:disabled) { opacity: 0.85; }

  .disclaimer {
    text-align: center;
    font-size: 11px;
    color: var(--ink-faint);
    margin-top: 4px;
  }

  @media (max-width: 480px) {
    .bubble { max-width: 92%; }
    .header-badge { display: none; }
  }
</style>
</head>
<body>

<header>
  <div class="header-icon">⚖</div>
  <span class="header-title">NIHL Evidence Advisor</span>
  <span class="header-badge">Powered by Neota Logic</span>
</header>
<div class="progress-track"><div class="progress-fill" id="progress"></div></div>

<main id="chat"></main>

<div class="input-dock">
  <div class="input-inner">
    <textarea id="input" placeholder="Describe your situation…" rows="1"></textarea>
    <button id="send-btn" onclick="send()">&#8593;</button>
  </div>
  <p class="disclaimer">Not a substitute for qualified legal advice.</p>
</div>

<script>
let history = [];
let answered = 0;
const total = 17;

function progress(n) {
  answered = Math.max(answered, n);
  document.getElementById('progress').style.width = Math.round(answered / total * 100) + '%';
}

function addMsg(role, text, opts = {}) {
  const chat = document.getElementById('chat');
  const wrap = document.createElement('div');
  wrap.className = 'msg ' + role;
  const av = document.createElement('div');
  av.className = 'avatar';
  av.textContent = role === 'assistant' ? '⚖' : '👤';
  const bub = document.createElement('div');
  bub.className = 'bubble';
  bub.innerHTML = text.replace(/\\n/g, '<br>');
  if (opts.pill) {
    const p = document.createElement('div');
    p.className = 'pill ' + opts.pill.type;
    p.textContent = opts.pill.text;
    bub.appendChild(document.createElement('br'));
    bub.appendChild(p);
  }
  if (opts.yesno) {
    const row = document.createElement('div');
    row.className = 'yn-row';
    ['Yes', 'No', 'Unsure'].forEach(l => {
      const b = document.createElement('button');
      b.className = 'yn-btn' + (l === 'Yes' ? ' yes' : l === 'No' ? ' no' : '');
      b.textContent = l;
      b.onclick = () => { document.querySelectorAll('.yn-btn').forEach(x => x.disabled = true); send(l); };
      row.appendChild(b);
    });
    bub.appendChild(row);
  }
  wrap.appendChild(av);
  wrap.appendChild(bub);
  chat.appendChild(wrap);
  chat.scrollTop = chat.scrollHeight;
  window.scrollTo(0, document.body.scrollHeight);
  return bub;
}

async function send(override) {
  const inp = document.getElementById('input');
  const text = override || inp.value.trim();
  if (!text) return;
  inp.value = '';
  inp.style.height = '';
  document.getElementById('send-btn').disabled = true;

  if (!override) addMsg('user', text);

  history.push({ role: 'user', content: text });

  const thinkBub = addMsg('assistant', '<span class="thinking">Thinking…</span>');

  try {
    const res = await fetch('/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: history })
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);

    thinkBub.innerHTML = data.text.replace(/\\n/g, '<br>');
    history = data.messages;

    if (data.apiResult) {
      const r = data.apiResult;
      progress(data.answeredCount || answered + 1);
      const pill = r.root === true
        ? { type: 'success', text: '✓ Strong case indicators' }
        : r.incomplete === true
          ? { type: 'incomplete', text: '⚠ More info needed' }
          : { type: 'fail', text: '✗ Case gaps identified' };
      const p = document.createElement('div');
      p.className = 'pill ' + pill.type;
      p.textContent = pill.text;
      thinkBub.appendChild(document.createElement('br'));
      thinkBub.appendChild(p);
    }

    const needsYN = data.text.includes('?') && data.text.split('?').length <= 3;
    if (needsYN) {
      const row = document.createElement('div');
      row.className = 'yn-row';
      ['Yes', 'No', 'Unsure'].forEach(l => {
        const b = document.createElement('button');
        b.className = 'yn-btn' + (l === 'Yes' ? ' yes' : l === 'No' ? ' no' : '');
        b.textContent = l;
        b.onclick = () => { document.querySelectorAll('.yn-btn').forEach(x => x.disabled = true); send(l); };
        row.appendChild(b);
      });
      thinkBub.appendChild(row);
    }

    if (data.answeredCount) progress(data.answeredCount);

  } catch(e) {
    thinkBub.innerHTML = 'Something went wrong: ' + e.message;
  }

  document.getElementById('send-btn').disabled = false;
  document.getElementById('chat').scrollTop = document.getElementById('chat').scrollHeight;
}

const inp = document.getElementById('input');
inp.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
});
inp.addEventListener('input', () => {
  inp.style.height = '';
  inp.style.height = Math.min(inp.scrollHeight, 120) + 'px';
});

(async () => {
  history.push({ role: 'user', content: 'Hello, I would like to understand if I might have a claim for noise-induced hearing loss from my workplace.' });
  const thinkBub = addMsg('assistant', '<span class="thinking">Loading…</span>');
  try {
    const res = await fetch('/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: history })
    });
    const data = await res.json();
    thinkBub.innerHTML = data.text.replace(/\\n/g, '<br>');
    history = data.messages;
    document.getElementById('send-btn').disabled = false;
  } catch(e) {
    thinkBub.innerHTML = 'Could not connect to the server. Please refresh.';
  }
})();
</script>
</body>
</html>`;

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", c => body += c);
    req.on("end", () => { try { resolve(JSON.parse(body)); } catch(e) { reject(e); } });
    req.on("error", reject);
  });
}

function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}

http.createServer(async (req, res) => {
  const path = url.parse(req.url).pathname;

  if (req.method === "GET" && (path === "/" || path === "/index.html")) {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(HTML);
    return;
  }

  if (req.method === "POST" && path === "/chat") {
    try {
      const { messages } = await readBody(req);
      if (!ANTHROPIC_API_KEY) { sendJSON(res, 500, { error: "ANTHROPIC_API_KEY not set" }); return; }
      const { text, apiResult, messages: updatedMessages } = await runNIHLLoop(messages);
      const answeredCount = updatedMessages.filter(m =>
        m.role === "user" && typeof m.content === "string" && m.content.length < 200
      ).length;
      sendJSON(res, 200, { text, apiResult, messages: updatedMessages, answeredCount });
    } catch(e) {
      console.error(e);
      sendJSON(res, 500, { error: e.message });
    }
    return;
  }

  res.writeHead(404);
  res.end("Not found");

}).listen(PORT, () => {
  console.log("NIHL Advisor running on port " + PORT);
  console.log("Anthropic API key:", ANTHROPIC_API_KEY ? "set" : "MISSING — set ANTHROPIC_API_KEY env var");
});
