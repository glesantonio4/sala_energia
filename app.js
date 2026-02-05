/* =================== Config Sala =================== */
const params = new URLSearchParams(location.search);
// Para la Sala Energía usamos el slug "energia" por defecto
const SALA = params.get('sala') || 'energia';

/* =================== Datos base =================== */
const NUM_QUESTIONS = 6;
const shuffle = a => a.map(x=>[Math.random(),x]).sort((p,q)=>p[0]-q[0]).map(p=>p[1]);

// Placeholder: QUESTIONS se inicializará tras cargar el JSON.
let QUESTIONS = [];

/* ==== SUPABASE: init + helpers (igual que ENTRADA MUCH) ==== */
const SUPABASE_URL = 'https://qwgaeorsymfispmtsbut.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InF3Z2Flb3JzeW1maXNwbXRzYnV0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjIzODcyODUsImV4cCI6MjA3Nzk2MzI4NX0.FThZIIpz3daC9u8QaKyRTpxUeW0v4QHs5sHX2s1U1eo';
let supabase = null;

async function initSupabase() {
  if (supabase) return supabase;
  const { createClient } = await import('https://esm.sh/@supabase/supabase-js@2');
  supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  return supabase;
}

// Toma un sala_id válido (de 'salas' o de 'quizzes') sin romper si no existe el nombre de sala
async function getAnySalaId() {
  await initSupabase();
  // 1) intenta desde 'salas'
  let { data, error } = await supabase.from('salas').select('id').limit(1);
  if (!error && data?.length) return data[0].id;

  // 2) fallback: toma sala_id usado en algún quiz
  ({ data, error } = await supabase
    .from('quizzes')
    .select('sala_id')
    .not('sala_id','is', null)
    .order('started_at', { ascending: false })
    .limit(1));
  if (!error && data?.length) return data[0].sala_id;

  return null; // si no hay, no tronamos
}

/** 🔹 NUEVO:
 * Obtiene el id de la sala **real** para esta instancia (SALA="energia"),
 * buscando primero por slug y luego por nombre. Si no encuentra nada,
 * usa getAnySalaId() como último recurso.
 */
async function getSalaIdForCurrentSala() {
  await initSupabase();
  const slug = (SALA || '').toLowerCase();

  // 1) Buscar por slug exacto (columna 'slug' en tabla salas)
  let { data, error } = await supabase
    .from('salas')
    .select('id, nombre, slug')
    .ilike('slug', slug)   // ej. 'energia'
    .limit(1);

  if (!error && data && data.length) {
    console.log('[QUIZ] Sala encontrada por slug:', data[0]);
    return data[0].id;
  }

  // 2) Buscar por nombre que contenga la palabra SALA (ej. "Sala Energía")
  ({ data, error } = await supabase
    .from('salas')
    .select('id, nombre, slug')
    .ilike('nombre', `%${SALA}%`)
    .limit(1));

  if (!error && data && data.length) {
    console.log('[QUIZ] Sala encontrada por nombre:', data[0]);
    return data[0].id;
  }

  // 3) Último recurso para no romper nada
  console.warn('[QUIZ] No se encontró sala específica para', SALA, '→ usando getAnySalaId()');
  return await getAnySalaId();
}

// Garantiza un participante_id (usa existente o crea vacío)
async function ensureParticipanteId() {
  await initSupabase();

  // 1) usa uno ya usado en quizzes
  let { data, error } = await supabase
    .from('quizzes')
    .select('participante_id')
    .not('participante_id', 'is', null)
    .order('started_at', { ascending: false })
    .limit(1);
  if (!error && data?.length) return data[0].participante_id;

  // 2) toma cualquiera de la tabla participantes
  ({ data, error } = await supabase
    .from('participantes')
    .select('id')
    .limit(1));
  if (!error && data?.length) return data[0].id;

  // 3) crea uno vacío (si tu esquema lo permite)
  const ins = await supabase
    .from('participantes')
    .insert({})
    .select('id')
    .single();

  if (ins.error) {
    console.warn('No se pudo crear participante:', ins.error.message);
    return null;
  }
  return ins.data.id;
}

// Crea un registro en quizzes cuando empieza el juego
async function startQuizInDB() {
  try {
    await initSupabase();

    // 🔁 AHORA usamos la sala real para esta instancia (Energía)
    const sala_id = await getSalaIdForCurrentSala();
    const participante_id = await ensureParticipanteId();

    const payload = {
      sala_id,
      participante_id,
      started_at: new Date().toISOString(),
      num_preguntas: NUM_QUESTIONS
    };

    const { data, error } = await supabase
      .from('quizzes')
      .insert(payload)
      .select('id')
      .single();

    if (error) { 
      console.warn('No se pudo crear quiz:', error.message); 
      return null; 
    }
    console.log('[QUIZ] Quiz creado para sala_id =', sala_id, '→ id quiz =', data.id);
    sessionStorage.setItem('much_current_quiz_id', data.id);
    return data.id;
  } catch (e) {
    console.warn('startQuizInDB error:', e?.message || e);
    return null;
  }
}

// Cierra el quiz en BD al terminar
async function endQuizInDB({ puntaje_total, num_correctas, num_preguntas }) {
  try {
    await initSupabase();
    const quizId = sessionStorage.getItem('much_current_quiz_id');
    if (!quizId) return;
    const { error } = await supabase
      .from('quizzes')
      .update({
        puntaje_total,
        num_correctas,
        num_preguntas,
        finished_at: new Date().toISOString()
      })
      .eq('id', quizId);
    if (error) console.warn('endQuizInDB error:', error.message);
  } catch (e) {
    console.warn('endQuizInDB ex:', e?.message || e);
  }
}

/* =================== Cargar preguntas =================== */
/**
 * Carga preguntas desde preguntas.json (esquema flexible multi-sala).
 * Si falla el fetch y la sala es "energia", usa un banco de respaldo local.
 */
async function loadPreguntas(){
  try{
    const resp = await fetch('preguntas.json', { cache: 'no-store' });
    if(!resp.ok) throw new Error('No se pudo cargar preguntas.json: ' + resp.status);
    let bank = await resp.json();

    // 1) Si viene por salas (objeto con arrays), intenta usar la sala actual; si no, toma el primer array.
    if (!Array.isArray(bank)) {
      const keys = Object.keys(bank || {});
      if (keys.length && bank[SALA]) {
        bank = bank[SALA];
      } else if (keys.length) {
        const firstKey = keys.find(k => Array.isArray(bank[k]));
        if (firstKey) bank = bank[firstKey];
      }
    }

    if(!Array.isArray(bank) || bank.length===0)
      throw new Error('preguntas.json no contiene un array de preguntas');

    // 2) Normaliza objetos a { text, options[], correctIndex, points, desc? }
    const normalize = (it) => {
      const text = it.text ?? it.pregunta ?? it.enunciado ?? 'Pregunta sin texto';
      const desc = it.desc ?? it.descripcion ?? '';
      let options = it.options ?? it.opciones ?? it.respuestas ?? [];
      let correctIndex = it.correctIndex ?? it.correcta_index;

      // Si options es array de objetos {texto, correcta}
      if (Array.isArray(options) && typeof options[0] === 'object') {
        const idx = options.findIndex(o => o.correcta === true || o.esCorrecta === true);
        if (correctIndex == null && idx >= 0) correctIndex = idx;
        options = options.map(o => o.text ?? o.texto ?? o.label ?? String(o));
      }

      // Si correcta es texto → buscar índice
      if (correctIndex == null && typeof it.correcta === 'string') {
        const idx2 = options.findIndex(o => String(o).trim() === String(it.correcta).trim());
        if (idx2 >= 0) correctIndex = idx2;
      }

      // Si hay respuesta numérica (1..n)
      if (correctIndex == null && (it.respuesta || it.respuesta_correcta)) {
        const num = (it.respuesta ?? it.respuesta_correcta) - 1;
        if (!Number.isNaN(num)) correctIndex = num;
      }

      const points = it.points ?? it.puntos ?? 1;

      if (!Array.isArray(options) || options.length === 0) {
        console.warn('Pregunta sin opciones:', it);
        options = ['(sin opciones)'];
        correctIndex = 0;
      }
      if (correctIndex == null || correctIndex < 0 || correctIndex >= options.length) {
        correctIndex = 0;
      }
      return { text, options, correctIndex, points, desc };
    };

    // 3) Filtro opcional por sala si el JSON trae campo sala/sala_codigo por pregunta
    const bySala = bank.filter(q =>
      !q?.sala && !q?.sala_codigo ? true :
      (q.sala === SALA || q.sala_codigo === SALA)
    );

    const pool = bySala.length ? bySala : bank;
    const normalized = pool.map(normalize);

    // 4) Mezcla y selecciona
    QUESTIONS = shuffle(normalized).slice(0, NUM_QUESTIONS);

    console.log('[loadPreguntas] SALA=', SALA, 'pool=', pool.length, 'usadas=', QUESTIONS.length, QUESTIONS);
    return QUESTIONS;
  }catch(err){
    console.error('[loadPreguntas] Error, intentando fallback para Energía si aplica:', err);

    // 🔁 Banco mínimo de respaldo SOLO para la sala Energía
    if (SALA === 'energia') {
      const fallback = [
        {
          text: "¿Cuál es una fuente de energía renovable?",
          desc: "Ejemplo de pregunta para la Sala Energía.",
          options: ["Petróleo", "Carbón", "Energía solar", "Gas natural"],
          correctIndex: 2,
          points: 10
        },
        {
          text: "¿Qué dispositivo convierte la luz del sol en electricidad?",
          desc: "",
          options: ["Turbina de viento", "Panel solar", "Calentador de gas", "Motor de combustión"],
          correctIndex: 1,
          points: 10
        },
        {
          text: "¿Cuál de estos es un beneficio de la energía renovable?",
          desc: "",
          options: ["Produce más contaminación", "Es casi inagotable", "Siempre es más cara", "Solo se usa de noche"],
          correctIndex: 1,
          points: 10
        },
        {
          text: "¿Qué tipo de energía aprovechamos con una turbina eólica?",
          desc: "",
          options: ["Energía térmica", "Energía nuclear", "Energía del viento", "Energía química"],
          correctIndex: 2,
          points: 10
        },
        {
          text: "¿Cuál de estos aparatos consume MÁS energía en casa normalmente?",
          desc: "",
          options: ["Televisor apagado", "Cargador desconectado", "Refrigerador", "Foco LED apagado"],
          correctIndex: 2,
          points: 10
        },
        {
          text: "¿Qué acción ayuda a ahorrar energía eléctrica?",
          desc: "",
          options: ["Dejar luces encendidas", "Usar focos LED", "Abrir el refrigerador a cada rato", "Tener aparatos en standby todo el día"],
          correctIndex: 1,
          points: 10
        }
      ];

      QUESTIONS = shuffle(fallback).slice(0, NUM_QUESTIONS);
      console.log('[loadPreguntas] Usando banco de respaldo para SALA=energia. Preguntas:', QUESTIONS.length);
      return QUESTIONS;
    }

    alert('Error al cargar preguntas. Revisa preguntas.json en el servidor.\n' + err.message);
    throw err;
  }
}

/* =================== Clases =================== */
class SoundFX{
  constructor(toggleEl){ this.toggleEl = toggleEl; this.ctx = null; }
  beep(freq=880, dur=0.15, type='sine', vol=0.08){
    if (this.toggleEl && !this.toggleEl.checked) return;
    this.ctx = this.ctx || new (window.AudioContext||window.webkitAudioContext)();
    const o=this.ctx.createOscillator(), g=this.ctx.createGain();
    o.type=type; o.frequency.value=freq; g.gain.value=vol;
    o.connect(g); g.connect(this.ctx.destination); o.start();
    setTimeout(()=>o.stop(), dur*1000);
  }
  correct(){ this.beep(880,.12,'sine',.08); setTimeout(()=>this.beep(1320,.12,'sine',.07),130); }
  wrong(){ this.beep(200,.18,'sawtooth',.07); }
}

class Confetti{
  constructor(canvas){
    this.canvas = canvas; this.ctx = canvas.getContext('2d');
    this.pieces=[]; this.resize(); addEventListener('resize', ()=>this.resize());
    this.loop();
  }
  resize(){ this.canvas.width = innerWidth; this.canvas.height = innerHeight; }
  launch(n=120){
    for(let i=0;i<n;i++){
      this.pieces.push({ x: Math.random()*this.canvas.width, y:-10, r:4+Math.random()*4, vy:2+Math.random()*3, vx:-2+Math.random()*4, rot:Math.random()*Math.PI*2 });
    }
  }
  loop(){
    requestAnimationFrame(()=>this.loop());
    const {ctx,canvas}=this; ctx.clearRect(0,0,canvas.width,canvas.height);
    this.pieces.forEach(p=>{
      p.x+=p.vx; p.y+=p.vy; p.rot+=0.05;
      ctx.save(); ctx.translate(p.x,p.y); ctx.rotate(p.rot);
      const palette = ['#06b6d4','#0891b2','#d946ef','#a21caf','#22d3ee','#f0abfc'];
      ctx.fillStyle = palette[(p.r|0) % palette.length];
      ctx.fillRect(-p.r,-p.r,p.r*2,p.r*2); ctx.restore();
    });
    this.pieces = this.pieces.filter(p=>p.y<canvas.height+20);
  }
}

class PrizeManager{
  constructor(){
    this.PRIZES = [
      { key:'museo',      title:'MUCH · Museo',      label:'Entrada al Museo MUCH',      lugar:'Museo Chiapas (MUCH)', emoji:'🏛️' },
      { key:'planetario', title:'MUCH · Planetario', label:'Entrada al Planetario MUCH', lugar:'Planetario MUCH',      emoji:'🔭' },
    ];
  }
  random(){ return this.PRIZES[Math.floor(Math.random()*this.PRIZES.length)]; }
}

class UIManager{
  constructor({elements, sound, confetti, prizeMgr}){
    this.e = elements; this.sound = sound; this.confetti = confetti; this.prizeMgr = prizeMgr;
    this.state = { idx:0, selected:null, points:0, correct:0, locked:false, answers:[] };
    this.currentPrize = null;

    // ⚡ Anti-trampa
    this.cheatingDetected = false;

    this.e.pillSala.textContent = `Sala: ${SALA}`;
    this.e.qTotal.textContent = QUESTIONS.length.toString();
    this.bind();
    this.render();
    this.clock();
    this.startFocusDetection();
  }

  startFocusDetection(){
    window.addEventListener('blur', this.handleFocusLoss.bind(this));
  }

  handleFocusLoss(){
    if (this.state.locked || this.cheatingDetected || this.state.idx >= QUESTIONS.length) return;
    this.cheatingDetected = true;
    this.state.locked = true;

    this.e.status.textContent = '🛑 ¡ATENCIÓN! Se detectó un cambio de ventana.';
    this.e.hint.textContent = 'Debes permanecer en esta pestaña. La ronda ha sido invalidada.';

    [...this.e.options.querySelectorAll('.option-btn')].forEach(btn => {
      btn.disabled = true;
      btn.classList.add('option-btn--incorrect');
    });

    this.e.nextBtn.textContent = '❌ Finalizar e Intentar de Nuevo';
    this.e.nextBtn.classList.remove('btn-primary');
    this.e.nextBtn.classList.add('btn-danger');

    this.sound.wrong();
  }

  bind(){
    this.e.nextBtn.addEventListener('click', ()=> this.next());
    this.e.openTicketBtn.addEventListener('click', ()=> this.redirectToRegistration());
    this.e.playAgainBtn1.addEventListener('click', ()=> location.reload());
    this.e.playAgainBtn2.addEventListener('click', ()=> location.reload());
  }

  clock(){
    const tick=()=>{
      const t=new Date(), hh=String(t.getHours()).padStart(2,'0'), mm=String(t.getMinutes()).padStart(2,'0');
      this.e.timer.textContent = `⏰ ${hh}:${mm}`;
      setTimeout(tick, 10_000);
    }; tick();
  }

  redirectToRegistration(){
    if(!this.currentPrize) return;
    const prizeData = {
      title: this.currentPrize.title,
      label: this.currentPrize.label,
      lugar: this.currentPrize.lugar,
      folio: 'MUCH-' + Math.random().toString(36).substring(2,8).toUpperCase(),
      date: new Intl.DateTimeFormat('es-MX',{dateStyle:'long'}).format(new Date()),
      emoji: this.currentPrize.emoji,
      sala: SALA
    };
    localStorage.setItem('much_quiz_prize', JSON.stringify(prizeData));

    const qs = new URLSearchParams({ sala: SALA });
    window.location.href = 'registro.html?' + qs.toString();
  }

  render(){
    const s=this.state, {e}=this;
    const pct = Math.min(100, (s.idx/QUESTIONS.length*100));
    e.bar.style.width = pct + '%';

    // Si hubo trampa, vamos directo a resultados/penalización
    if (this.cheatingDetected) {
      e.quizView.classList.add('d-none');
      e.finalView.classList.remove('d-none');

      e.finalTitle.textContent = '¡Ronda Invalidada! 🛑';
      e.finalMsg.textContent = 'Se detectó un intento de abandono de pestaña. Debes reintentar la ronda completa.';
      e.giftRow.classList.add('d-none');
      e.retryRow.classList.remove('d-none');

      e.finalPoints.textContent = s.points.toString();
      e.finalCorrect.textContent = s.correct.toString();
      e.finalTotal.textContent = QUESTIONS.length.toString();
      return;
    }

    if(s.idx>=QUESTIONS.length){
      const allCorrect = s.correct===QUESTIONS.length;

      // Cerrar quiz en BD (no bloquea la UI)
      endQuizInDB({
        puntaje_total: Math.round((s.correct / QUESTIONS.length) * 100),
        num_correctas: s.correct,
        num_preguntas: QUESTIONS.length
      });

      if(allCorrect){
        const prize = this.prizeMgr.random();
        this.currentPrize = prize;
        this.redirectToRegistration();
        return;
      } else {
        e.quizView.classList.add('d-none');
        e.finalView.classList.remove('d-none');
        e.finalTitle.textContent = 'Buen intento 👀';
        e.finalMsg.textContent   = 'Explora el MUCH y vuelve a intentarlo.';
        e.giftRow.classList.add('d-none');
        e.retryRow.classList.remove('d-none');
        e.finalPoints.textContent = s.points.toString();
        e.finalCorrect.textContent= s.correct.toString();
        e.finalTotal.textContent  = QUESTIONS.length.toString();
        return;
      }
    }

    const q = QUESTIONS[s.idx];
    e.qIndex.textContent = (s.idx+1).toString();
    e.qText.textContent  = q.text;
    e.qDesc.textContent  = q.desc || '';
    e.status.textContent = '';
    e.options.innerHTML  = '';
    s.selected=null; s.locked=false;

    q.options.forEach((label,i)=>{
      // Ya no usamos col-12 col-md-6 para forzar lista vertical limpia
      const btn=document.createElement('button'); btn.type='button'; btn.className='option-btn';
      btn.setAttribute('data-index', i);
      // Emoji azul (diamante) + texto
      btn.innerHTML = `<span class="emoji">🔹</span><span>${label}</span>`;
      btn.addEventListener('click', ()=> this.choose(i));
      e.options.appendChild(btn);
    });

    e.nextBtn.textContent = s.idx===QUESTIONS.length-1 ? 'Finalizar 🎉' : 'Siguiente ➡️';
    e.pointsEl.textContent = s.points.toString();
    e.hint.textContent = 'Tip: solo puedes elegir una respuesta';
  }

  choose(i){
    const s=this.state, {e}=this;
    if(s.locked) return;
    if(this.cheatingDetected) return;

    s.locked=true; s.selected=i;
    const q=QUESTIONS[s.idx], correctIdx=q.correctIndex;
    [...e.options.querySelectorAll('.option-btn')].forEach((btn,idx)=>{
      btn.disabled=true; btn.classList.remove('option-btn--correct','option-btn--incorrect');
      if(idx===correctIdx) btn.classList.add('option-btn--correct');
      if(idx===i && i!==correctIdx) btn.classList.add('option-btn--incorrect');
    });
    if(i===correctIdx){
      e.status.textContent='✅ ¡Correcto!';
      s.points+=q.points; s.correct+=1;
      this.sound.correct(); this.confetti.launch(40);
    } else {
      e.status.textContent='❌ ¡Casi! Sigue intentando';
      this.sound.wrong();
    }
    s.answers.push({ qIndex:s.idx, question:q.text, choice:q.options[i], correct:i===correctIdx });
  }

  next(){
    const s=this.state, {e}=this;
    if (this.cheatingDetected) { location.reload(); return; }

    if(s.selected===null){ e.status.textContent='⚠️ Selecciona una respuesta para continuar.'; return; }
    e.nextBtn.disabled = true; setTimeout(()=>{ e.nextBtn.disabled=false; }, 180);
    s.idx+=1; this.render();
  }
}

/* =================== Instanciación segura =================== */

// Referencias a elementos del QUIZ (si no existen, quedan en null)
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

const sound    = new SoundFX(elements.soundToggle || null);
const confetti = new Confetti(document.getElementById('confetti'));

/** Arranque flexible:
 * - Si hay portada (welcome + startBtn), inicia al click.
 * - Si NO hay portada (index directo), auto-inicia.
 */
document.addEventListener('DOMContentLoaded', ()=>{
  const welcome  = document.getElementById('welcome');
  const quizShell= document.getElementById('quizShell');
  const startBtn = document.getElementById('startBtn');
  const prizeMgr = new PrizeManager();

  const start = async ()=>{
    try{
      await loadPreguntas();    // llena QUESTIONS
      await startQuizInDB();    // crea un quiz en Supabase
      if (welcome) welcome.classList.add('hidden');
      if (quizShell) quizShell.classList.remove('hidden');
      new UIManager({ elements, sound, confetti, prizeMgr });
    }catch(err){
      console.error('No se pudo iniciar el quiz:', err);
    }
  };

  if (startBtn && welcome) {
    startBtn.addEventListener('click', (e)=>{ e.preventDefault(); start(); });
  } else {
    start();
  }
});

