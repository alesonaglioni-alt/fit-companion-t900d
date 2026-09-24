'use strict';

// ===== Costanti FTMS =====
const FTMS_SERVICE = 0x1826;
const TREADMILL_DATA_CHAR = 0x2acd;
const CONTROL_POINT_CHAR = 0x2ad9;

const RESULT_CODES = {
  1: 'Success', 2: 'Op Code Not Supported', 3: 'Invalid Parameter',
  4: 'Operation Failed', 5: 'Control Not Permitted'
};

const STORAGE_KEY = 'fitcompanion_templates_v1';

// ===== Stato globale =====
const state = {
  device: null,
  server: null,
  treadmillChar: null,
  controlPointChar: null,
  controlWritable: null, // null = non ancora testato, true/false dopo il test
  telemetry: { speed: 0, incline: 0 },
  recording: { active: false, samples: [], startTime: 0, timerId: null },
  execution: null // { steps, idx, mode, timerId, template }
};

// ===== Utility UI =====
function $(id) { return document.getElementById(id); }

function log(msg, cls) {
  const el = $('log');
  const line = document.createElement('div');
  const time = new Date().toLocaleTimeString('it-IT', { hour12: false });
  line.textContent = `[${time}] ${msg}`;
  if (cls === 'err') line.style.color = '#f87171';
  if (cls === 'tx') line.style.color = '#fcd34d';
  el.appendChild(line);
  el.scrollTop = el.scrollHeight;
}

function setConnStatus(text, kind) {
  $('connText').textContent = text;
  $('connDot').className = 'dot' + (kind ? ' ' + kind : '');
}

function fmtTime(totalSec) {
  const s = Math.max(0, Math.round(totalSec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
}

// ===== Navigazione tab =====
document.querySelectorAll('nav.tabs button').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('nav.tabs button').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('section.screen').forEach(s => s.classList.remove('active'));
    btn.classList.add('active');
    $('screen-' + btn.dataset.screen).classList.add('active');
    if (btn.dataset.screen === 'library') renderTemplateList();
  });
});

// ===== Bluetooth: connessione =====
async function connect() {
  try {
    log('Apro il selettore dispositivi Bluetooth...');
    state.device = await navigator.bluetooth.requestDevice({
      filters: [
        { services: [FTMS_SERVICE] },
        { namePrefix: 'domyos-tc-' }
      ],
      optionalServices: [FTMS_SERVICE]
    });
    state.device.addEventListener('gattserverdisconnected', onDisconnected);

    state.server = await state.device.gatt.connect();
    const service = await state.server.getPrimaryService(FTMS_SERVICE);

    state.treadmillChar = await service.getCharacteristic(TREADMILL_DATA_CHAR);
    await state.treadmillChar.startNotifications();
    state.treadmillChar.addEventListener('characteristicvaluechanged', onTreadmillData);
    log('Sottoscritto a Treadmill Data.');

    try {
      state.controlPointChar = await service.getCharacteristic(CONTROL_POINT_CHAR);
      await state.controlPointChar.startNotifications();
      state.controlPointChar.addEventListener('characteristicvaluechanged', onControlPointResponse);
      log('Control Point trovato, verifico se accetta comandi...');
      await testControlWritable();
    } catch (e) {
      state.controlPointChar = null;
      state.controlWritable = false;
      log('Control Point non disponibile: ' + e.message, 'err');
      updateControlModeUI();
    }

    setConnStatus('Connesso a ' + (state.device.name || 'tapis roulant'), 'ok');
    $('btnConnect').disabled = true;
    $('btnDisconnect').disabled = false;
    $('btnStartRecording').disabled = false;
    $('recordDisabledHint').hidden = true;
  } catch (e) {
    log('Errore di connessione: ' + e.message, 'err');
    setConnStatus('Connessione fallita', 'bad');
  }
}

async function testControlWritable() {
  // Manda "Request Control": se risponde Success, il Control Point è scrivibile.
  await writeControlPoint([0x00], 'Request Control (test)');
  // La risposta arriva async via onControlPointResponse, che aggiorna state.controlWritable.
  setTimeout(updateControlModeUI, 1500);
}

function updateControlModeUI() {
  const card = $('manualControlCard');
  if (state.controlWritable === true) {
    $('controlModeText').textContent = 'Modalità controllo: Auto-drive (scrittura confermata)';
    card.hidden = false;
  } else if (state.controlWritable === false) {
    $('controlModeText').textContent = 'Modalità controllo: Guidato (scrittura non disponibile su questo dispositivo)';
    card.hidden = true;
  } else {
    $('controlModeText').textContent = 'Modalità controllo: verifica in corso...';
  }
}

function onDisconnected() {
  setConnStatus('Disconnesso', 'warn');
  $('btnConnect').disabled = false;
  $('btnDisconnect').disabled = true;
  $('btnStartRecording').disabled = true;
  $('recordDisabledHint').hidden = false;
  log('Dispositivo disconnesso.');
}

function disconnect() {
  if (state.device && state.device.gatt.connected) state.device.gatt.disconnect();
}

// ===== Parsing Treadmill Data =====
function parseTreadmillData(dv) {
  let offset = 0;
  const flags = dv.getUint16(offset, true); offset += 2;
  const hasFlag = bit => (flags & (1 << bit)) !== 0;

  let speed = state.telemetry.speed, incline = state.telemetry.incline;
  let distance, elapsed, calories, hr;

  if (!hasFlag(0)) { speed = dv.getUint16(offset, true) / 100; offset += 2; }
  if (hasFlag(1)) offset += 2;
  if (hasFlag(2)) {
    const b0 = dv.getUint8(offset), b1 = dv.getUint8(offset + 1), b2 = dv.getUint8(offset + 2);
    distance = b0 | (b1 << 8) | (b2 << 16); offset += 3;
  }
  if (hasFlag(3)) { incline = dv.getInt16(offset, true) / 10; offset += 2; offset += 2; }
  if (hasFlag(4)) offset += 4;
  if (hasFlag(5)) offset += 1;
  if (hasFlag(6)) offset += 1;
  if (hasFlag(7)) { calories = dv.getUint16(offset, true); offset += 2; offset += 2; offset += 1; }
  if (hasFlag(8)) { hr = dv.getUint8(offset); offset += 1; }
  if (hasFlag(9)) offset += 1;
  if (hasFlag(10)) { elapsed = dv.getUint16(offset, true); offset += 2; }

  state.telemetry.speed = speed;
  state.telemetry.incline = incline;

  $('tSpeed').textContent = speed.toFixed(2) + ' km/h';
  $('tIncline').textContent = incline.toFixed(1) + ' %';
  if (distance !== undefined) $('tDistance').textContent = distance + ' m';
  if (elapsed !== undefined) $('tElapsed').textContent = fmtTime(elapsed);
  if (calories !== undefined) $('tCalories').textContent = calories + ' kcal';
  if (hr !== undefined) $('tHr').textContent = hr + ' bpm';

  if (state.recording.active) {
    state.recording.samples.push({ t: Date.now(), speed, incline });
    $('recSpeed').textContent = speed.toFixed(2) + ' km/h';
    $('recIncline').textContent = incline.toFixed(1) + ' %';
  }
}

function onTreadmillData(event) {
  try { parseTreadmillData(event.target.value); }
  catch (e) { log('Errore parsing telemetria: ' + e.message, 'err'); }
}

function onControlPointResponse(event) {
  const dv = event.target.value;
  if (dv.byteLength >= 3 && dv.getUint8(0) === 0x80) {
    const requestOpCode = dv.getUint8(1);
    const resultCode = dv.getUint8(2);
    const resultText = RESULT_CODES[resultCode] || `Sconosciuto (${resultCode})`;
    log(`Risposta Control Point per 0x${requestOpCode.toString(16)}: ${resultText}`, resultCode === 1 ? null : 'err');
    if (requestOpCode === 0x00) {
      state.controlWritable = (resultCode === 1);
      updateControlModeUI();
    }
  }
}

async function writeControlPoint(bytes, label) {
  if (!state.controlPointChar) { log('Control Point non disponibile: ' + label, 'err'); return; }
  try {
    const buf = new Uint8Array(bytes);
    log(`TX ${label}`, 'tx');
    await state.controlPointChar.writeValueWithResponse(buf);
  } catch (e) {
    log(`Errore inviando "${label}": ${e.message}`, 'err');
  }
}

function cmdRequestControl() { return writeControlPoint([0x00], 'Request Control'); }
function cmdStart() { return writeControlPoint([0x07], 'Start/Resume'); }
function cmdStop() { return writeControlPoint([0x08, 0x01], 'Stop'); }
function cmdSetSpeed(kmh) {
  const raw = Math.round(kmh * 100);
  return writeControlPoint([0x02, raw & 0xff, (raw >> 8) & 0xff], `Set Speed ${kmh} km/h`);
}
function cmdSetIncline(pct) {
  let raw = Math.round(pct * 10);
  if (raw < 0) raw = 0x10000 + raw;
  return writeControlPoint([0x03, raw & 0xff, (raw >> 8) & 0xff], `Set Incline ${pct}%`);
}

// ===== Registrazione allenamento libero =====
function startRecording() {
  state.recording = { active: true, samples: [], startTime: Date.now(), timerId: null };
  $('recordIdleCard').hidden = true;
  $('recordActiveCard').hidden = false;
  $('saveChoiceCard').hidden = true;
  $('recStepCount').textContent = '0';
  state.recording.timerId = setInterval(() => {
    const elapsedSec = (Date.now() - state.recording.startTime) / 1000;
    $('recElapsed').textContent = fmtTime(elapsedSec);
    $('recStepCount').textContent = String(compactSamples(state.recording.samples).length);
  }, 1000);
}

function stopRecording() {
  state.recording.active = false;
  clearInterval(state.recording.timerId);
  $('recordActiveCard').hidden = true;

  const steps = compactSamples(state.recording.samples);
  const totalSec = steps.reduce((a, s) => a + s.durationSec, 0);
  $('saveChoiceSummary').textContent =
    `${steps.length} step rilevati, durata totale ${fmtTime(totalSec)}.`;
  $('saveChoiceCard').hidden = false;
  $('saveChoiceCard')._pendingSteps = steps;
}

function discardRecording() {
  $('saveChoiceCard').hidden = true;
  $('recordIdleCard').hidden = false;
}

// Raggruppa le letture grezze in step {durationSec, speedKmh, inclinePct}
function compactSamples(samples, opts) {
  const { speedTol = 0.2, inclineTol = 0.3, minStepSec = 3 } = opts || {};
  if (!samples.length) return [];
  let steps = [];
  let cur = { speed: samples[0].speed, incline: samples[0].incline, startT: samples[0].t };
  for (let i = 1; i < samples.length; i++) {
    const s = samples[i];
    if (Math.abs(s.speed - cur.speed) > speedTol || Math.abs(s.incline - cur.incline) > inclineTol) {
      steps.push({ durationSec: Math.round((s.t - cur.startT) / 1000), speedKmh: cur.speed, inclinePct: cur.incline });
      cur = { speed: s.speed, incline: s.incline, startT: s.t };
    }
  }
  const last = samples[samples.length - 1];
  steps.push({ durationSec: Math.round((last.t - cur.startT) / 1000) + 1, speedKmh: cur.speed, inclinePct: cur.incline });

  const merged = [];
  for (const st of steps) {
    if (st.durationSec < minStepSec && merged.length) merged[merged.length - 1].durationSec += st.durationSec;
    else merged.push(Object.assign({}, st));
  }
  return merged.filter(s => s.durationSec > 0);
}

function scaleSteps(steps, factor, target) {
  return steps.map(s => ({
    durationSec: s.durationSec,
    speedKmh: target !== 'incline' ? Math.round(s.speedKmh * factor * 10) / 10 : s.speedKmh,
    inclinePct: target !== 'speed' ? Math.round(s.inclinePct * factor * 10) / 10 : s.inclinePct
  }));
}

// ===== Storage template (localStorage) =====
function loadTemplates() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || []; }
  catch (e) { return []; }
}
function saveTemplates(list) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
}
function addTemplate(tpl) {
  const list = loadTemplates();
  list.push(tpl);
  saveTemplates(list);
}

function saveAsIs() {
  const name = $('inTemplateName').value.trim() || `Allenamento ${new Date().toLocaleDateString('it-IT')}`;
  const steps = $('saveChoiceCard')._pendingSteps || [];
  addTemplate({ id: crypto.randomUUID(), name, steps, createdAt: Date.now() });
  log(`Allenamento "${name}" salvato (${steps.length} step).`);
  discardRecording();
}

function saveScaled() {
  const baseName = $('inTemplateName').value.trim() || `Allenamento ${new Date().toLocaleDateString('it-IT')}`;
  const steps = $('saveChoiceCard')._pendingSteps || [];
  const pct = parseFloat($('inScalePercent').value) || 10;
  const factor = 1 + pct / 100;
  addTemplate({ id: crypto.randomUUID(), name: baseName, steps, createdAt: Date.now() });
  const scaled = scaleSteps(steps, factor, 'both');
  addTemplate({ id: crypto.randomUUID(), name: `${baseName} +${pct}%`, steps: scaled, createdAt: Date.now(), scaledFrom: baseName, scaleFactor: factor });
  log(`Salvati "${baseName}" e variante "+${pct}%".`);
  discardRecording();
}

// ===== Creazione manuale allenamento =====
function addBuilderStepRow(duration = 5, speed = 5.0, incline = 0) {
  const container = $('builderSteps');
  const row = document.createElement('div');
  row.className = 'row builder-step';
  row.innerHTML = `
    <input type="number" class="stepDuration" value="${duration}" min="0.1" step="0.5" style="width:70px"> min
    <input type="number" class="stepSpeed" value="${speed}" min="0" step="0.1" style="width:70px"> km/h
    <input type="number" class="stepIncline" value="${incline}" min="0" step="0.5" style="width:70px"> %
    <button class="btn danger" type="button">&#10005;</button>
  `;
  row.querySelector('button').addEventListener('click', () => row.remove());
  container.appendChild(row);
}

function saveBuilderTemplate() {
  const name = $('inBuilderName').value.trim();
  const rows = document.querySelectorAll('#builderSteps .builder-step');
  if (!name) { log('Inserisci un nome per l\'allenamento.', 'err'); return; }
  if (!rows.length) { log('Aggiungi almeno uno step.', 'err'); return; }
  const steps = Array.from(rows).map(row => ({
    durationSec: Math.round(parseFloat(row.querySelector('.stepDuration').value) * 60),
    speedKmh: parseFloat(row.querySelector('.stepSpeed').value),
    inclinePct: parseFloat(row.querySelector('.stepIncline').value)
  })).filter(s => s.durationSec > 0 && !isNaN(s.speedKmh) && !isNaN(s.inclinePct));

  if (!steps.length) { log('Controlla i valori inseriti negli step.', 'err'); return; }

  addTemplate({ id: crypto.randomUUID(), name, steps, createdAt: Date.now() });
  log(`Allenamento "${name}" creato manualmente (${steps.length} step).`);

  $('inBuilderName').value = '';
  $('builderSteps').innerHTML = '';
  addBuilderStepRow();
  renderTemplateList();
}

// ===== Libreria allenamenti =====
function renderTemplateList() {
  const list = loadTemplates();
  const container = $('templateList');
  container.innerHTML = '';
  $('templateEmpty').hidden = list.length > 0;

  list.slice().reverse().forEach(tpl => {
    const totalSec = tpl.steps.reduce((a, s) => a + s.durationSec, 0);
    const div = document.createElement('div');
    div.className = 'template-item';
    div.innerHTML = `
      <div class="name">${escapeHtml(tpl.name)}</div>
      <div class="meta">${tpl.steps.length} step &middot; ${fmtTime(totalSec)}</div>
      <div class="row">
        <button class="btn secondary" data-act="start">Avvia uguale</button>
        <input type="number" value="10" min="1" max="100" style="width:60px" data-role="pct">
        <button class="btn" data-act="startpct">Avvia pi&ugrave; difficile</button>
        <button class="btn danger" data-act="delete">Elimina</button>
      </div>
    `;
    div.querySelector('[data-act="start"]').addEventListener('click', () => startExecution(tpl, 1, 'both'));
    div.querySelector('[data-act="startpct"]').addEventListener('click', () => {
      const pct = parseFloat(div.querySelector('[data-role="pct"]').value) || 10;
      startExecution(tpl, 1 + pct / 100, 'both');
    });
    div.querySelector('[data-act="delete"]').addEventListener('click', () => {
      saveTemplates(loadTemplates().filter(t => t.id !== tpl.id));
      renderTemplateList();
    });
    container.appendChild(div);
  });
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ===== Esecuzione allenamento (auto-drive o guidato) =====
let audioCtx = null;
function beep() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.frequency.value = 880;
    osc.connect(gain); gain.connect(audioCtx.destination);
    gain.gain.setValueAtTime(0.15, audioCtx.currentTime);
    osc.start();
    osc.stop(audioCtx.currentTime + 0.15);
  } catch (e) { /* audio non disponibile, non bloccante */ }
}

function startExecution(template, factor, target) {
  const steps = factor !== 1 ? scaleSteps(template.steps, factor, target) : template.steps;
  const mode = state.controlWritable === true ? 'auto' : 'guided';
  state.execution = { steps, idx: -1, mode, timerId: null, remaining: 0, beeped: false };

  $('executionCard').hidden = false;
  $('execModeBadge').textContent = mode === 'auto' ? 'Auto-drive' : 'Guidato';
  $('execModeBadge').className = 'badge' + (mode === 'guided' ? ' guided' : '');

  if (mode === 'auto') cmdStart();
  nextStep();
  state.execution.timerId = setInterval(tickExecution, 1000);
}

function nextStep() {
  const ex = state.execution;
  ex.idx++;
  if (ex.idx >= ex.steps.length) { stopExecution(true); return; }
  const step = ex.steps[ex.idx];
  ex.remaining = step.durationSec;
  ex.beeped = false;
  $('execCountdown').textContent = fmtTime(ex.remaining);

  $('execCurrentStep').textContent = `${step.speedKmh.toFixed(1)} km/h · ${step.inclinePct.toFixed(1)}%`;
  const next = ex.steps[ex.idx + 1];
  $('execNextStep').textContent = next
    ? `Prossimo: ${next.speedKmh.toFixed(1)} km/h, ${next.inclinePct.toFixed(1)}% tra ${fmtTime(step.durationSec)}`
    : 'Ultimo step dell\'allenamento';

  if (ex.mode === 'auto') {
    cmdSetSpeed(step.speedKmh);
    cmdSetIncline(step.inclinePct);
  } else {
    beep();
  }
}

function tickExecution() {
  const ex = state.execution;
  if (!ex) return;
  ex.remaining--;
  $('execCountdown').textContent = fmtTime(ex.remaining);
  if (ex.mode === 'guided' && ex.remaining <= 5 && ex.remaining > 0 && !ex.beeped) {
    // piccolo avviso sonoro prima del cambio, per dare tempo di reagire
    beep();
  }
  if (ex.remaining <= 0) nextStep();
}

function stopExecution(completed) {
  if (state.execution) {
    clearInterval(state.execution.timerId);
    if (state.execution.mode === 'auto') cmdStop();
  }
  state.execution = null;
  $('executionCard').hidden = true;
  log(completed ? 'Allenamento completato.' : 'Allenamento interrotto.');
}

// ===== Event listeners =====
$('btnConnect').addEventListener('click', connect);
$('btnDisconnect').addEventListener('click', disconnect);
$('btnStart').addEventListener('click', () => { cmdRequestControl().then(cmdStart); });
$('btnStop').addEventListener('click', cmdStop);
$('btnSetSpeed').addEventListener('click', () => cmdSetSpeed(parseFloat($('inSpeed').value)));
$('btnSetIncline').addEventListener('click', () => cmdSetIncline(parseFloat($('inIncline').value)));

$('btnStartRecording').addEventListener('click', startRecording);
$('btnStopRecording').addEventListener('click', stopRecording);
$('btnDiscard').addEventListener('click', discardRecording);
$('btnSaveAsIs').addEventListener('click', saveAsIs);
$('btnSaveScaled').addEventListener('click', saveScaled);
$('btnStopExecution').addEventListener('click', () => stopExecution(false));
$('btnAddBuilderStep').addEventListener('click', () => addBuilderStepRow());
$('btnSaveBuilder').addEventListener('click', saveBuilderTemplate);
addBuilderStepRow();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('service-worker.js').catch(e => log('Service worker non registrato: ' + e.message, 'err'));
}

if (!navigator.bluetooth) {
  setConnStatus('Web Bluetooth non disponibile (usa Chrome desktop o Android)', 'bad');
  $('btnConnect').disabled = true;
}

renderTemplateList();
