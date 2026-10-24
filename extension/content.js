// Runs on aistudio.google.com.
// 1. Watches Gemini's latest reply for an MCP tool call.
// 2. Shows an approval overlay. Nothing runs, and Gemini gets no result, until you decide.
// 3. Runs the tool through the background worker and posts the result as your next
//    message, so Gemini continues from there.
(() => {
  'use strict';
  if (window.__aiStudioMcp) return;
  window.__aiStudioMcp = true;

  const MAX_RESULT_CHARS = 30000;
  const POLL_MS = 1000;

  // Best-effort selectors for the AI Studio page. If AI Studio changes its markup
  // and the extension stops noticing replies or submitting results, adjust these.
  const SEL = {
    turn: 'ms-chat-turn',
    modelMarker: '.model, [data-turn-role="Model"]',
    run: 'button.run-button, button[aria-label="Run"], button[aria-label="Send"]',
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /* ---------------- page helpers ---------------- */

  function findInput() {
    const boxes = [...document.querySelectorAll('textarea')].filter((t) => t.offsetParent !== null);
    const labelled = boxes.find((t) => /prompt|type something|message/i.test(t.getAttribute('aria-label') || t.placeholder || ''));
    return labelled || boxes[boxes.length - 1] || null;
  }

  function setText(el, text) {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setter.call(el, text);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.focus();
  }

  async function submit(input) {
    for (let i = 0; i < 15; i++) {
      const btn = document.querySelector(SEL.run);
      if (btn && !btn.disabled && btn.getAttribute('aria-disabled') !== 'true') {
        btn.click();
        return;
      }
      await sleep(200);
    }
    input.focus();
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, ctrlKey: true, bubbles: true }));
  }

  function lastModelTurn() {
    const turns = [...document.querySelectorAll(SEL.turn)];
    for (let i = turns.length - 1; i >= 0; i--) {
      const el = turns[i];
      if (!(el.textContent || '').trim()) continue;
      const isModel = el.matches(SEL.modelMarker) || !!el.querySelector(SEL.modelMarker);
      return isModel ? { el, index: i } : null;
    }
    return null;
  }

  // Finds {"mcp_call":{"server":..,"tool":..,"arguments":{..}}} in the reply text.
  function extractCall(text) {
    const m = /\{\s*"mcp_call"\s*:/.exec(text);
    if (!m) return null;
    let depth = 0, inStr = false, esc = false;
    for (let i = m.index; i < text.length; i++) {
      const c = text[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}' && --depth === 0) {
        try {
          const o = JSON.parse(text.slice(m.index, i + 1)).mcp_call;
          const ok = o && typeof o.server === 'string' && typeof o.tool === 'string' && o.server !== 'SERVER';
          return ok ? { server: o.server, tool: o.tool, args: o.arguments || {} } : null;
        } catch {
          return null;
        }
      }
    }
    return null; // JSON not finished yet (still streaming)
  }

  /* ---------------- overlay UI ---------------- */

  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `
<style>
  :host{--bg:#fbfbf9;--fg:#16191d;--mut:#5b6470;--line:#d3d8de;--ok:#0b6f69;--okfg:#fff;--hold:#b45309;--bad:#b3261e;--code:#eef0f2}
  @media (prefers-color-scheme:dark){:host{--bg:#1a1d22;--fg:#e7e9ec;--mut:#9aa3ad;--line:#363c44;--ok:#46c2b8;--okfg:#0d1a19;--hold:#f0b35a;--bad:#f2928a;--code:#12151a}}
  *{box-sizing:border-box}
  button{font:inherit;cursor:pointer}
  :focus-visible{outline:2px solid var(--ok);outline-offset:2px}
  #pill{position:fixed;right:16px;bottom:16px;pointer-events:auto;display:flex;gap:8px;align-items:center;
    font:500 12px/1 system-ui,sans-serif;color:var(--fg);background:var(--bg);border:1px solid var(--line);
    border-radius:999px;padding:8px 12px}
  #pill.hold{border-color:var(--hold)}
  #pill i{width:8px;height:8px;border-radius:50%;background:var(--mut)}
  #pill.hold i{background:var(--hold)}
  #scrim{position:fixed;inset:0;display:none;place-items:center;background:rgba(10,12,15,.6);pointer-events:auto}
  #scrim.on{display:grid}
  .card{width:min(580px,92vw);max-height:88vh;overflow:auto;background:var(--bg);color:var(--fg);
    border:1px solid var(--line);border-left:4px solid var(--hold);border-radius:6px;padding:22px 24px;
    font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
  h2{margin:0 0 6px;font:600 20px/1.3 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;overflow-wrap:anywhere}
  p{margin:0 0 14px;color:var(--mut);max-width:60ch}
  textarea{display:block;width:100%;height:170px;resize:vertical;background:var(--code);color:var(--fg);
    border:1px solid var(--line);border-radius:4px;padding:10px 12px;font:13px/1.55 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
  #err{min-height:20px;margin:6px 0 0;color:var(--bad);font-size:13px}
  .row{display:flex;gap:8px;align-items:center;margin-top:10px;flex-wrap:wrap}
  .grow{flex:1}
  .row button{border-radius:4px;padding:9px 14px;border:1px solid var(--line);background:transparent;color:var(--fg)}
  .row .primary{background:var(--ok);border-color:var(--ok);color:var(--okfg);font-weight:600}
  #deny{color:var(--mut)}
</style>
<button id="pill" title="Click to insert the MCP tool list into the message box"><i></i><span id="label">MCP</span></button>
<div id="scrim"><div class="card" id="card" role="dialog" aria-modal="true" aria-labelledby="tool" tabindex="-1">
  <h2 id="tool"></h2>
  <p>Gemini is waiting to run this tool. Approve to send the result back so it can continue.</p>
  <textarea id="args" spellcheck="false" aria-label="Tool arguments (editable JSON)"></textarea>
  <div id="err" role="alert"></div>
  <div class="row">
    <button id="deny">Deny</button><span class="grow"></span>
    <button id="always">Always allow this tool</button>
    <button id="ok" class="primary">Approve</button>
  </div>
</div></div>`;
  document.documentElement.appendChild(host);

  const $ = (id) => root.getElementById(id);
  let statusTimer = null;

  function setStatus(text, hold = false) {
    clearTimeout(statusTimer);
    $('label').textContent = text ? `MCP: ${text}` : 'MCP';
    $('pill').classList.toggle('hold', hold);
  }
  function flash(text, ms = 3000) {
    setStatus(text);
    statusTimer = setTimeout(() => setStatus(''), ms);
  }

  function ask(call) {
    return new Promise((resolve) => {
      $('tool').textContent = `${call.server}.${call.tool}`; // textContent: names come from the model
      $('args').value = JSON.stringify(call.args, null, 2);
      $('err').textContent = '';
      $('scrim').classList.add('on');
      $('card').focus();
      setStatus('waiting for your approval', true);

      const finish = (ok, always) => {
        let args = call.args;
        if (ok) {
          try {
            args = JSON.parse($('args').value.trim() || '{}');
          } catch (e) {
            $('err').textContent = 'The arguments are not valid JSON: ' + e.message;
            return;
          }
        }
        $('scrim').classList.remove('on');
        $('scrim').onkeydown = null;
        resolve({ ok, always, args });
      };
      $('ok').onclick = () => finish(true, false);
      $('always').onclick = () => finish(true, true);
      $('deny').onclick = () => finish(false, false);
      $('scrim').onkeydown = (e) => e.key === 'Escape' && finish(false, false);
    });
  }

  $('pill').onclick = async () => {
    try {
      const r = await chrome.runtime.sendMessage({ type: 'toolPrompt' });
      if (!r || !r.ok) return flash(r && r.error ? r.error : 'extension not responding', 7000);
      const input = findInput();
      if (input) {
        setText(input, r.prompt + (input.value ? '\n\n' + input.value : ''));
        flash('tool list inserted');
      } else {
        await navigator.clipboard.writeText(r.prompt);
        flash('message box not found, tool list copied', 5000);
      }
    } catch (e) {
      flash(e.message, 7000);
    }
  };

  /* ---------------- main flow ---------------- */

  async function reply(text) {
    const input = findInput();
    if (!input) {
      try { await navigator.clipboard.writeText(text); } catch {}
      return flash('message box not found, result copied', 6000);
    }
    setText(input, text);
    await submit(input);
  }

  async function handle(call) {
    const id = `${call.server}.${call.tool}`;
    try {
      const { autoApprove = {} } = await chrome.storage.local.get('autoApprove');
      const decision = autoApprove[id] ? { ok: true, args: call.args } : await ask(call);

      if (!decision.ok) {
        setStatus('');
        return await reply(`MCP RESULT for ${id}: the user denied this call. Do not retry it; ask how they want to proceed.`);
      }
      if (decision.always) {
        const cur = (await chrome.storage.local.get('autoApprove')).autoApprove || {};
        await chrome.storage.local.set({ autoApprove: { ...cur, [id]: true } });
      }

      setStatus(`running ${id}`);
      const r = await chrome.runtime.sendMessage({ type: 'call', server: call.server, tool: call.tool, args: decision.args });
      let body = r && r.ok ? r.text : `ERROR: ${(r && r.error) || 'no response from the extension'}`;
      if (body.length > MAX_RESULT_CHARS) body = body.slice(0, MAX_RESULT_CHARS) + '\n[truncated]';
      setStatus('');
      await reply(`MCP RESULT for ${id}${r && r.isError ? ' (the tool reported an error)' : ''}:\n<tool_result>\n${body}\n</tool_result>`);
    } catch (e) {
      flash('error: ' + e.message, 7000);
    }
  }

  let armed = false;      // false while a chat is loading, so old calls in history are ignored
  let armTimer = null;
  let lastHref = location.href;
  let candidate = '';     // a call must look identical on two polls before we act on it
  let busy = false;
  const seen = new Set();

  const arm = () => {
    armed = false;
    clearTimeout(armTimer);
    armTimer = setTimeout(() => { armed = true; }, 2500);
  };
  arm();

  setInterval(async () => {
    if (busy) return;
    if (location.href !== lastHref) {
      lastHref = location.href;
      candidate = '';
      arm();
    }
    const turn = lastModelTurn();
    const call = turn && extractCall(turn.el.textContent || '');
    if (!call) { candidate = ''; return; }

    const key = `${turn.index}:${JSON.stringify(call)}`;
    if (seen.has(key)) return;
    if (!armed) { seen.add(key); return; }
    if (candidate !== key) { candidate = key; return; }

    seen.add(key);
    candidate = '';
    busy = true;
    try { await handle(call); } finally { busy = false; }
  }, POLL_MS);
})();
