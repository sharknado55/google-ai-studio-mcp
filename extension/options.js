const $ = (id) => document.getElementById(id);
const BRIDGE_ORIGINS = ['http://127.0.0.1:3939', 'http://localhost:3939'];

const DEFAULT_CONFIG = {
  servers: [
    { name: 'files', url: 'http://127.0.0.1:3939/mcp/files' },
    { name: 'example-remote', url: 'https://example.com/mcp', headers: { Authorization: 'Bearer YOUR_TOKEN' }, enabled: false },
  ],
};

const out = (text) => { $('out').textContent = text; };

function parseConfig() {
  const cfg = JSON.parse($('cfg').value);
  if (!Array.isArray(cfg.servers)) throw new Error('"servers" must be a list.');
  for (const s of cfg.servers) {
    if (!/^[\w-]+$/.test(s.name || '')) throw new Error(`Invalid server name: ${JSON.stringify(s.name)}`);
    if (!/^https?:\/\//.test(s.url || '')) throw new Error(`Server "${s.name}" needs an http(s) URL.`);
  }
  return cfg;
}

function renderAuto(map) {
  const box = $('auto');
  box.textContent = '';
  const ids = Object.keys(map);
  if (!ids.length) {
    box.textContent = 'No tools are always allowed yet.';
    return;
  }
  for (const id of ids) {
    const row = document.createElement('div');
    row.className = 'tool';
    const name = document.createElement('code');
    name.textContent = id;
    const btn = document.createElement('button');
    btn.textContent = 'Ask again';
    btn.onclick = async () => {
      delete map[id];
      await chrome.storage.local.set({ autoApprove: map });
      renderAuto(map);
    };
    row.append(name, btn);
    box.append(row);
  }
}

async function load() {
  const { config, autoApprove } = await chrome.storage.local.get(['config', 'autoApprove']);
  $('cfg').value = JSON.stringify(config || DEFAULT_CONFIG, null, 2);
  renderAuto(autoApprove || {});
}

$('save').onclick = async () => {
  try {
    const cfg = parseConfig();
    const origins = [...new Set(
      cfg.servers.map((s) => new URL(s.url).origin).filter((o) => !BRIDGE_ORIGINS.includes(o)).map((o) => o + '/*')
    )];
    if (origins.length && !(await chrome.permissions.request({ origins }))) {
      throw new Error('Chrome needs access to the server addresses. Save again and choose Allow.');
    }
    await chrome.storage.local.set({ config: cfg });
    out('Saved.');
  } catch (e) {
    out('Not saved: ' + e.message);
  }
};

$('test').onclick = async () => {
  out('Connecting…');
  const r = await chrome.runtime.sendMessage({ type: 'test' });
  out(r && r.ok ? r.text : 'Test failed: ' + ((r && r.error) || 'no response'));
};

load();
