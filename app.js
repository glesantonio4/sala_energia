/* =================== Datos de Configuración =================== */
const params = new URLSearchParams(location.search);
const SALA = params.get('sala') || 'energia';
const NUM_QUESTIONS = 6;
// Función para mezclar arrays
const shuffle = a => a.map(x => [Math.random(), x]).sort((p, q) => p[0] - q[0]).map(p => p[1]);

// Placeholder: Se llenará desde el JSON
let QUESTIONS = [];
// 🔒 BANDERA DE SEGURIDAD (Evita dobles registros al dar clic rápido)
let quizIniciando = false;

/* ================================================================= */
/* ==== SUPABASE: CONEXIÓN Y LÓGICA DE BASE DE DATOS =========== */
/* ================================================================= */

const SUPABASE_URL = 'https://qwgaeorsymfispmtsbut.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InF3Z2Flb3JzeW1maXNwbXRzYnV0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjIzODcyODUsImV4cCI6MjA3Nzk2MzI4NX0.FThZIIpz3daC9u8QaKyRTpxUeW0v4QHs5sHX2s1U1eo';

// 🔒 ID EXACTO DE LA SALA "ENERGÍA"
const SALA_ENTRADA_ID = '08a6cc96-5323-42e0-89df-77a8c36e9705';

let supabase = null;

// Inicializa la librería
async function initSupabase() {
  if (supabase) return supabase;
  const { createClient } = await import('https://esm.sh/@supabase/supabase-js@2');
  supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  return supabase;
}

// ⏰ FUNCIÓN CRÍTICA: Obtener hora exacta de México
function getMexicoTime() {
  const ahora = new Date();
  const offsetMexico = ahora.getTimezoneOffset() * 60000;
  const localTime = new Date(ahora.getTime() - offsetMexico);
  return localTime.toISOString();
}

// ------------------------------------------------------------
// 1. CARGAR PREGUNTAS DESDE ARCHIVO JSON
// ------------------------------------------------------------
async function loadPreguntas() {
  try {
    const resp = await fetch('preguntas.json', { cache: 'no-store' });
    if (!resp.ok) throw new Error('No se pudo cargar preguntas.json: ' + resp.status);
    let bank = await resp.json();

    if (!Array.isArray(bank)) {
      const keys = Object.keys(bank || {});
      if (keys.length && bank[SALA]) {
        bank = bank[SALA];
      } else if (keys.length) {
        const firstKey = keys.find(k => Array.isArray(bank[k]));
        if (firstKey) bank = bank[firstKey];
      }
    }

    if (!Array.isArray(bank) || bank.length === 0)
      throw new Error('preguntas.json no contiene un array de preguntas');

    const normalize = (it) => {
      const text = it.text ?? it.pregunta ?? it.enunciado ?? 'Pregunta sin texto';
      const desc = it.desc ?? it.descripcion ?? '';
      let options = it.options ?? it.opciones ?? it.respuestas ?? [];
      let correctIndex = it.correctIndex ?? it.correcta_index;

      if (Array.isArray(options) && typeof options[0] === 'object') {
        const idx = options.findIndex(o => o.correcta === true || o.esCorrecta === true);
        if (correctIndex == null && idx >= 0) correctIndex = idx;
        options = options.map(o => o.text ?? o.texto ?? o.label ?? String(o));
      }

      if (correctIndex == null && typeof it.correcta === 'string') {
        const idx2 = options.findIndex(o => String(o).trim() === String(it.correcta).trim());
        if (idx2 >= 0) correctIndex = idx2;
      }

      if (correctIndex == null && (it.respuesta || it.respuesta_correcta)) {
        const num = (it.respuesta ?? it.respuesta_correcta) - 1;
        if (!Number.isNaN(num)) correctIndex = num;
      }

      const points = it.points ?? it.puntos ?? 10;

      if (!Array.isArray(options) || options.length === 0) {
        options = ['(sin opciones)'];
        correctIndex = 0;
      }
      if (correctIndex == null || correctIndex < 0 || correctIndex >= options.length) {
        correctIndex = 0;
      }
      return { text, options, correctIndex, points, desc };
    };

    const bySala = bank.filter(q =>
      !q?.sala && !q?.sala_codigo ? true :
        (q.sala === SALA || q.sala_codigo === SALA)
    );

    const pool = bySala.length ? bySala : bank;
    const normalized = pool.map(normalize);

    QUESTIONS = shuffle(normalized).slice(0, NUM_QUESTIONS);
    console.log('[loadPreguntas] JSON Cargado. Total preguntas:', QUESTIONS.length);
    return QUESTIONS;
  } catch (err) {
    console.error(err);
    alert('Error al cargar preguntas.json.\n' + err.message);
    throw err;
  }
}

// ------------------------------------------------------------
// ------------------------------------------------------------
// 2. GESTIÓN DE PARTIDAS (DB TRACKING)
// ------------------------------------------------------------

/**
 * 🐆 ASEGURAR QUE EL PARTICIPANTE EXISTA
 * Si no hay un usuario en sesión, crea uno temporal "Jugador Anónimo".
 */
async function ensureParticipanteId() {
  await initSupabase();

  // 1. Verificamos si ya tenemos el ID guardado en sesión
  const existingId = sessionStorage.getItem("usuario_id");
  if (existingId) return existingId;

  const randomSuffix = Math.floor(Math.random() * 999999);
  try {
    console.log("Creando jugador temporal en Ganadores...");
    const { data, error } = await supabase
      .from('Ganadores')
      .insert([
        {
          nombre: 'Visitante Energía',
          correo: `visitante.${randomSuffix}@much.mx`, // Email único para evitar errores de duplicidad
          telefono: '0000000000',
          folio: 'V-' + randomSuffix,
          valido_desde: getMexicoTime()
        }
      ])
      .select('id')
      .single();

    if (error) {
      console.warn("No se pudo crear jugador nuevo, buscando fallback...", error.message);
      // Fallback: Si no podemos crear uno, buscamos el ID de cualquier ganador existente 
      // para evitar que la columna se quede NULL.
      const { data: fallback } = await supabase
        .from('Ganadores')
        .select('id')
        .order('id', { ascending: false })
        .limit(1);

      if (fallback && fallback.length > 0) {
        return fallback[0].id;
      }
      return null;
    }

    console.log("Jugador temporal creado con ID:", data.id);
    sessionStorage.setItem("usuario_id", data.id);
    return data.id;

  } catch (e) {
    console.error("Error fatal en ensureParticipanteId:", e);
    return null;
  }
}

async function startQuizInDB() {
  if (quizIniciando) return sessionStorage.getItem('much_current_quiz_id');
  quizIniciando = true;

  try {
    await initSupabase();

    // Reset de seguridad
    sessionStorage.removeItem('much_quiz_final_data');

    // 1. Validar si ya hay un juego activo en esta sesión
    const juegoActivo = sessionStorage.getItem('much_current_quiz_id');
    if (juegoActivo) {
      return juegoActivo;
    }

    // 2. Obtener un ID de participante válido (Nunca NULL)
    const participante_id = await ensureParticipanteId();
    if (!participante_id) {
      console.error("No se pudo obtener ID de participante.");
      quizIniciando = false;
      return null;
    }

    // 2. Insertar nuevo intento vinculado al participante real o temporal
    const payload = {
      sala_id: SALA_ENTRADA_ID,
      participante_id: participante_id, // <--- AQUÍ EVITAMOS QUE SALGA VACÍO
      started_at: getMexicoTime(),
      num_preguntas: NUM_QUESTIONS,
      puntaje_total: 0,
      num_correctas: 0,
      estatus: 'activo'
    };

    console.log("Guardando intento en BD...");
    const { data, error } = await supabase
      .from('quizzes')
      .insert(payload)
      .select('id')
      .single();

    if (error) {
      console.error("❌ Error Supabase (Start):", error.message);
      quizIniciando = false;
      startQuizLocal();
      return null;
    }

    console.log("✅ Intento iniciado. ID:", data.id);

    // Guardamos en SessionStorage (para uso interno del quiz)
    sessionStorage.setItem('much_current_quiz_id', data.id);

    // ⚠️ CRUCIAL: Guardamos en LocalStorage con la clave que busca registro.html
    localStorage.setItem('much_quiz_db_id', String(data.id));

    return data.id;

  } catch (e) {
    console.error("Excepción al iniciar quiz:", e);
    quizIniciando = false;
    startQuizLocal();
    return null;
  }
}

async function endQuizInDB({ puntaje_total, num_correctas, num_preguntas }) {
  // Guardamos localmente para tener respaldo
  saveQuizResultLocal({ puntaje_total, num_correctas, num_preguntas });

  try {
    await initSupabase();
    const quizId = sessionStorage.getItem('much_current_quiz_id');
    if (!quizId) return;

    console.log(`🏁 Finalizando intento ${quizId}...`);

    const { error } = await supabase.from('quizzes').update({
      puntaje_total: puntaje_total,
      num_correctas: num_correctas,
      num_preguntas: num_preguntas,
      finished_at: getMexicoTime(),
      estatus: 'finalizado'
    }).eq('id', quizId);

    if (error) console.error("Error al finalizar (DB):", error.message);
    else console.log("✅ Intento actualizado en BD.");

  } catch (e) { console.warn('Error endQuizInDB:', e); }
}

// Fallback Functions
function startQuizLocal() {
  if (sessionStorage.getItem('much_quiz_start')) return;
  const startTime = getMexicoTime();
  sessionStorage.setItem('much_quiz_start', startTime);
}

function saveQuizResultLocal(data) {
  const startTime = sessionStorage.getItem('much_quiz_start') || getMexicoTime();
  const quizData = { ...data, sala_id: SALA_ENTRADA_ID, started_at: startTime, finished_at: getMexicoTime() };

  // Guardamos datos para registro.html (por si la BD falló antes)
  localStorage.setItem('much_quiz_final_data', JSON.stringify(quizData));

  // Reforzamos el ID en localStorage
  const dbId = sessionStorage.getItem('much_current_quiz_id');
  if (dbId) localStorage.setItem('much_quiz_db_id', dbId);
}


/* =================== Clases UI =================== */
class SoundFX {
  constructor(toggleEl) { this.toggleEl = toggleEl; this.ctx = null; }
  beep(freq = 880, dur = 0.15, type = 'sine', vol = 0.08) {
    if (this.toggleEl && !this.toggleEl.checked) return;
    this.ctx = this.ctx || new (window.AudioContext || window.webkitAudioContext)();
    const o = this.ctx.createOscillator(), g = this.ctx.createGain();
    o.type = type; o.frequency.value = freq; g.gain.value = vol;
    o.connect(g); g.connect(this.ctx.destination); o.start();
    setTimeout(() => o.stop(), dur * 1000);
  }
  correct() { this.beep(880, .12, 'sine', .08); setTimeout(() => this.beep(1320, .12, 'sine', .07), 130); }
  wrong() { this.beep(200, .18, 'sawtooth', .07); }
}

class Confetti {
  constructor(canvas) {
    this.canvas = canvas; this.ctx = canvas.getContext('2d');
    this.pieces = []; this.resize(); addEventListener('resize', () => this.resize());
    this.loop();
  }
  resize() { this.canvas.width = innerWidth; this.canvas.height = innerHeight; }
  launch(n = 120) {
    for (let i = 0; i < n; i++) {
      this.pieces.push({ x: Math.random() * this.canvas.width, y: -10, r: 4 + Math.random() * 4, vy: 2 + Math.random() * 3, vx: -2 + Math.random() * 4, rot: Math.random() * Math.PI * 2 });
    }
  }
  loop() {
    requestAnimationFrame(() => this.loop());
    const { ctx, canvas } = this; ctx.clearRect(0, 0, canvas.width, canvas.height);
    this.pieces.forEach(p => {
      p.x += p.vx; p.y += p.vy; p.rot += 0.05;
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot);
      const palette = ['#06b6d4', '#0891b2', '#d946ef', '#a21caf', '#22d3ee', '#f0abfc'];
      ctx.fillStyle = palette[(p.r | 0) % palette.length];
      ctx.fillRect(-p.r, -p.r, p.r * 2, p.r * 2); ctx.restore();
    });
    this.pieces = this.pieces.filter(p => p.y < canvas.height + 20);
  }
}

class PrizeManager {
  constructor() {
    this.PRIZES = [
      { key: 'museo', title: 'MUCH · Museo', label: 'Entrada al Museo MUCH', lugar: 'Museo Chiapas (MUCH)', emoji: '🏛️' },
      { key: 'planetario', title: 'MUCH · Planetario', label: 'Entrada al Planetario MUCH', lugar: 'Planetario MUCH', emoji: '🔭' },
      { key: 'general', title: 'MUCH · Visita General', label: 'Visita General (Museo + Planetario)', lugar: 'Museo y Planetario', emoji: '🌟' },
    ];
  }
  random() { return this.PRIZES[Math.floor(Math.random() * this.PRIZES.length)]; }
}

class UIManager {
  constructor({ elements, sound, confetti, prizeMgr }) {
    this.e = elements; this.sound = sound; this.confetti = confetti; this.prizeMgr = prizeMgr;
    this.state = { idx: 0, selected: null, points: 0, correct: 0, locked: false, answers: [] };
    this.currentPrize = null;
    this.cheatingDetected = false;

    if (this.e.pillSala) this.e.pillSala.textContent = `Sala: ${SALA}`;
    if (this.e.qTotal) this.e.qTotal.textContent = QUESTIONS.length.toString();
    this.bind();
    this.render();
    this.clock();
    this.startFocusDetection();
  }

  startFocusDetection() {
    window.addEventListener('blur', this.handleFocusLoss.bind(this));
  }

  handleFocusLoss() {
    if (this.state.locked || this.cheatingDetected || this.state.idx >= QUESTIONS.length) return;
    this.cheatingDetected = true;
    this.state.locked = true;

    if (this.e.status) this.e.status.textContent = '🛑 ¡ATENCIÓN! No cambies de pestaña.';
    if (this.e.hint) this.e.hint.textContent = 'La ronda ha sido invalidada por salir del juego.';

    [...this.e.options.querySelectorAll('.option-btn')].forEach(btn => {
      btn.disabled = true;
      btn.classList.add('option-btn--incorrect');
    });

    this.e.nextBtn.textContent = '❌ Reintentar';
    this.e.nextBtn.classList.remove('btn-primary');
    this.e.nextBtn.classList.add('btn-danger');
    this.sound.wrong();
  }

  bind() {
    this.e.nextBtn.addEventListener('click', () => this.next());
    this.e.openTicketBtn.addEventListener('click', () => this.redirectToRegistration());
    this.e.playAgainBtn1.addEventListener('click', () => location.reload());
    this.e.playAgainBtn2.addEventListener('click', () => location.reload());
  }

  clock() {
    const tick = () => {
      const t = new Date(), hh = String(t.getHours()).padStart(2, '0'), mm = String(t.getMinutes()).padStart(2, '0');
      if (this.e.timer) this.e.timer.textContent = `⏰ ${hh}:${mm}`;
      setTimeout(tick, 10_000);
    }; tick();
  }

  redirectToRegistration() {
    if (!this.currentPrize) return;
    const prizeData = {
      title: this.currentPrize.title,
      label: this.currentPrize.label,
      lugar: this.currentPrize.lugar,
      folio: 'MUCH-' + Math.random().toString(36).substring(2, 8).toUpperCase(),
      date: new Intl.DateTimeFormat('es-MX', { dateStyle: 'long' }).format(new Date()),
      emoji: this.currentPrize.emoji
    };
    localStorage.setItem('much_quiz_prize', JSON.stringify(prizeData));
    window.location.href = 'registro.html';
  }

  render() {
    const s = this.state, { e } = this;
    const pct = Math.min(100, (s.idx / QUESTIONS.length * 100));
    e.bar.style.width = pct + '%';

    if (this.cheatingDetected) {
      e.quizView.classList.add('d-none');
      e.finalView.classList.remove('d-none');
      e.finalTitle.textContent = '¡Ronda Invalidada!';
      e.finalMsg.textContent = 'Se detectó actividad sospechosa. Intenta de nuevo.';
      e.giftRow.classList.add('d-none');
      e.retryRow.classList.remove('d-none');
      e.finalPoints.textContent = s.points.toString();
      e.finalCorrect.textContent = s.correct.toString();
      e.finalTotal.textContent = QUESTIONS.length.toString();
      return;
    }

    if (s.idx >= QUESTIONS.length) {
      const allCorrect = s.correct === QUESTIONS.length;

      // 10 puntos por acierto
      const puntajeFinal = s.correct * 10;

      // Guardamos en local y DB
      saveQuizResultLocal({
        puntaje_total: puntajeFinal,
        num_correctas: s.correct,
        num_preguntas: QUESTIONS.length
      });

      endQuizInDB({
        puntaje_total: puntajeFinal,
        num_correctas: s.correct,
        num_preguntas: QUESTIONS.length
      });

      if (allCorrect) {
        const prize = this.prizeMgr.random();
        this.currentPrize = prize;
        setTimeout(() => this.redirectToRegistration(), 500);
        return;
      } else {
        e.quizView.classList.add('d-none');
        e.finalView.classList.remove('d-none');
        e.finalTitle.textContent = 'Buen intento 👀';
        e.finalMsg.textContent = 'Sigue explorando el museo.';
        e.giftRow.classList.add('d-none');
        e.retryRow.classList.remove('d-none');
        e.finalPoints.textContent = s.points.toString();
        e.finalCorrect.textContent = s.correct.toString();
        e.finalTotal.textContent = QUESTIONS.length.toString();
        return;
      }
    }

    const q = QUESTIONS[s.idx];
    if (e.qIndex) e.qIndex.textContent = (s.idx + 1).toString();
    if (e.qText) e.qText.textContent = q.text;
    if (e.qDesc) e.qDesc.textContent = q.desc || '';
    if (e.status) e.status.textContent = '';
    if (e.options) e.options.innerHTML = '';
    s.selected = null; s.locked = false;

    q.options.forEach((label, i) => {
      const col = document.createElement('div'); col.className = 'col-12';
      const btn = document.createElement('button'); btn.type = 'button'; btn.className = 'option-btn';
      btn.setAttribute('data-index', i);
      btn.innerHTML = `<span class="emoji">🔹</span><span>${label}</span>`;
      btn.addEventListener('click', () => this.choose(i));
      col.appendChild(btn); e.options.appendChild(col);
    });

    e.nextBtn.textContent = s.idx === QUESTIONS.length - 1 ? 'Finalizar 🎉' : 'Siguiente ➡️';
    if (e.pointsEl) e.pointsEl.textContent = s.points.toString();
    if (e.hint) e.hint.textContent = 'Tip: solo puedes elegir una respuesta';
  }

  choose(i) {
    const s = this.state, { e } = this;
    if (s.locked) return;
    if (this.cheatingDetected) return;

    s.locked = true; s.selected = i;
    const q = QUESTIONS[s.idx], correctIdx = q.correctIndex;
    [...e.options.querySelectorAll('.option-btn')].forEach((btn, idx) => {
      btn.disabled = true; btn.classList.remove('option-btn--correct', 'option-btn--incorrect');
      if (idx === correctIdx) btn.classList.add('option-btn--correct');
      if (idx === i && i !== correctIdx) btn.classList.add('option-btn--incorrect');
    });
    if (i === correctIdx) {
      if (e.status) e.status.textContent = '✅ ¡Correcto!';
      s.points += q.points; s.correct += 1;
      this.sound.correct(); this.confetti.launch(40);
    } else {
      if (e.status) e.status.textContent = '❌ ¡Incorrecto!';
      this.sound.wrong();
    }
    s.answers.push({ qIndex: s.idx, question: q.text, choice: q.options[i], correct: i === correctIdx });
  }

  next() {
    const s = this.state, { e } = this;
    if (this.cheatingDetected) { location.reload(); return; }
    if (s.selected === null) { if (e.status) e.status.textContent = '⚠️ Selecciona una respuesta.'; return; }
    e.nextBtn.disabled = true; setTimeout(() => { e.nextBtn.disabled = false; }, 180);
    s.idx += 1; this.render();
  }
}

/* =================== Arranque =================== */
const elements = {
  pillSala: document.getElementById('pillSala'),
  bar: document.getElementById('bar'),
  timer: document.getElementById('timer'),
  quizView: document.getElementById('quizView'),
  finalView: document.getElementById('finalView'),
  qIndex: document.getElementById('qIndex'),
  qTotal: document.getElementById('qTotal'),
  qText: document.getElementById('qText'),
  qDesc: document.getElementById('qDesc'),
  options: document.getElementById('options'),
  status: document.getElementById('status'),
  nextBtn: document.getElementById('nextBtn'),
  pointsEl: document.getElementById('points'),
  hint: document.getElementById('hint'),
  finalTitle: document.getElementById('finalTitle'),
  finalMsg: document.getElementById('finalMsg'),
  finalPoints: document.getElementById('finalPoints'),
  finalCorrect: document.getElementById('finalCorrect'),
  finalTotal: document.getElementById('finalTotal'),
  giftRow: document.getElementById('giftRow'),
  retryRow: document.getElementById('retryRow'),
  openTicketBtn: document.getElementById('openTicketBtn'),
  playAgainBtn1: document.getElementById('playAgainBtn1'),
  playAgainBtn2: document.getElementById('playAgainBtn2'),
  soundToggle: document.getElementById('soundToggle'),
  logoEmoji: document.getElementById('logoEmoji'),
};

const sound = new SoundFX(elements.soundToggle || null);
const confetti = new Confetti(document.getElementById('confetti'));

document.addEventListener('DOMContentLoaded', () => {
  const welcome = document.getElementById('welcome');
  const quizShell = document.getElementById('quizShell');
  const startBtn = document.getElementById('startBtn');
  const prizeMgr = new PrizeManager();

  const start = async () => {
    try {
      await loadPreguntas();
      startQuizInDB(); // Inicia sesión en BD (con el ID de Visitante)
      if (welcome) welcome.classList.add('hidden');
      if (quizShell) quizShell.classList.remove('hidden');
      new UIManager({ elements, sound, confetti, prizeMgr });
    } catch (err) {
      console.error('No se pudo iniciar el quiz:', err);
    }
  };

  if (startBtn && welcome) {
    startBtn.addEventListener('click', (e) => { e.preventDefault(); start(); });
  } else {
    start();
  }
});