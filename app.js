(() => {
  const D = window.X0510;
  const STORE = "x0510-v2";
  const screen = document.getElementById("screen");
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  // ---------- состояние ----------
  // Живёт в localStorage, чтобы квест переживал перезагрузку и закрытие вкладки.
  // done[id] хранит сам ответ модуля: без него не расшифровать сообщение после перезагрузки.
  // at: отметки времени (мс) — loginAt (первый показ входа), authAt (вход), [id модуля] (решён).
  const fresh = () => ({ auth: false, guesses: [], lockouts: 0, done: {}, gates: {}, input: {}, fails: {}, tuned: {}, at: {} });
  let state = load();
  function load() {
    try {
      const s = JSON.parse(localStorage.getItem(STORE));
      if (s && s.done) return Object.assign(fresh(), s);
    } catch (_) {}
    return fresh();
  }
  function save() { try { localStorage.setItem(STORE, JSON.stringify(state)); } catch (_) {} }

  // ---------- утилиты ----------
  async function sha(s) {
    const buf = await crypto.subtle.digest("SHA-256", enc.encode(s));
    return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
  }
  async function decrypt(secret, b64) {
    const data = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const out = new Uint8Array(data.length);
    for (let i = 0, off = 0; off < data.length; i++, off += 32) {
      const block = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(`k|${secret}|${i}`)));
      for (let j = 0; j < 32 && off + j < data.length; j++) out[off + j] = data[off + j] ^ block[j];
    }
    return dec.decode(out);
  }
  const norm = v => String(v).toUpperCase().replace(/Ё/g, "Е").replace(/\s+/g, "");
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const el = (tag, cls, html) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  };
  const buzz = p => { try { navigator.vibrate && navigator.vibrate(p); } catch (_) {} };
  const now = () => Date.now();
  function fmt(ms) {
    if (!(ms >= 0)) return "--:--";
    const t = Math.round(ms / 1000), h = Math.floor(t / 3600), m = Math.floor(t / 60) % 60, sec = t % 60;
    const p = n => String(n).padStart(2, "0");
    return (h ? h + ":" + p(m) : p(m)) + ":" + p(sec);
  }
  let ticker = null;
  const stopTicker = () => { clearInterval(ticker); ticker = null; };
  const shake = () => { screen.classList.add("shake"); setTimeout(() => screen.classList.remove("shake"), 400); };

  async function type(line, cls = "", speed = 14) {
    const p = el("div", "line cursor " + cls);
    screen.appendChild(p);
    for (const ch of line) { p.textContent += ch; if (ch !== " ") await sleep(speed); }
    p.classList.remove("cursor");
    return p;
  }

  const noise = document.getElementById("noise");
  const nctx = noise.getContext("2d");
  async function interference(ms = 600) {
    noise.width = 120; noise.height = 220;
    noise.classList.add("on");
    const end = performance.now() + ms;
    while (performance.now() < end) {
      const img = nctx.createImageData(noise.width, noise.height);
      for (let i = 0; i < img.data.length; i += 4) {
        const v = Math.random() * 255;
        img.data[i] = v * .3; img.data[i + 1] = v; img.data[i + 2] = v * .5; img.data[i + 3] = 255;
      }
      nctx.putImageData(img, 0, 0);
      await sleep(40);
    }
    noise.classList.remove("on");
  }

  // Web Audio можно запустить только из обработчика нажатия (iOS), поэтому контекст создаётся лениво.
  // На iPhone в беззвучном режиме звука не будет — звук везде продублирован светом и вибрацией.
  let audio;
  function tone(freq, ms, vol = .18) {
    try {
      audio = audio || new (window.AudioContext || window.webkitAudioContext)();
      if (audio.state === "suspended") audio.resume();
      const o = audio.createOscillator(), g = audio.createGain();
      o.type = "sine"; o.frequency.value = freq;
      const t = audio.currentTime;
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(vol, t + .01);
      g.gain.setValueAtTime(vol, t + ms / 1000 - .02);
      g.gain.linearRampToValueAtTime(0, t + ms / 1000);
      o.connect(g).connect(audio.destination);
      o.start(t); o.stop(t + ms / 1000 + .02);
    } catch (_) {}
  }

  // ---------- клавиатуры ----------
  const LAYOUTS = {
    ru: [
      ["Й", "Ц", "У", "К", "Е", "Н", "Г", "Ш", "Щ", "З", "Х", "Ъ"],
      ["Ф", "Ы", "В", "А", "П", "Р", "О", "Л", "Д", "Ж", "Э"],
      ["⌫", "Я", "Ч", "С", "М", "И", "Т", "Ь", "Б", "Ю", "⏎"],
    ],
    jamo: [
      ["ㅂ", "ㅈ", "ㄷ", "ㄱ", "ㅅ", "ㅛ", "ㅕ", "ㅑ", "ㅐ", "ㅔ"],
      ["ㅁ", "ㄴ", "ㅇ", "ㄹ", "ㅎ", "ㅗ", "ㅓ", "ㅏ", "ㅣ"],
      ["⌫", "ㅋ", "ㅌ", "ㅊ", "ㅍ", "ㅠ", "ㅜ", "ㅡ", "⏎"],
    ],
    digits: [["1", "2", "3"], ["4", "5", "6"], ["7", "8", "9"], ["⌫", "0", "⏎"]],
  };
  const ENTER_LABEL = { ru: "ВВОД", jamo: "АНАЛИЗ", digits: "ВВОД" };

  function keyboard(layout, onKey) {
    const kb = el("div", "kbd kbd-" + layout);
    const keys = {};
    LAYOUTS[layout].forEach(row => {
      const r = el("div", "krow");
      row.forEach(ch => {
        const special = ch === "⌫" || ch === "⏎";
        const k = el("button", "key" + (special ? " wide" : ""), ch === "⏎" ? ENTER_LABEL[layout] : ch);
        k.onclick = () => { if (!special) buzz(5); onKey(ch); };
        keys[ch] = k;
        r.appendChild(k);
      });
      kb.appendChild(r);
    });
    kb.keys = keys;
    return kb;
  }

  // Физическая клавиатура (если открыто с компьютера) — в обработчик активного экрана.
  let keyHandler = null;
  document.addEventListener("keydown", e => {
    if (!keyHandler) return;
    if (e.key === "Backspace") keyHandler("⌫");
    else if (e.key === "Enter") keyHandler("⏎");
    else if (/^[а-яё0-9]$/i.test(e.key)) keyHandler(e.key.toUpperCase().replace("Ё", "Е"));
  });

  function view(title, back = true) {
    screen.innerHTML = "";
    keyHandler = null;
    stopTicker();
    const head = el("div", "vhead");
    if (back) {
      const b = el("button", "back", "◂ ЛАБОРАТОРИЯ");
      b.onclick = lab;
      head.appendChild(b);
    }
    head.appendChild(el("div", "vtitle", title));
    screen.appendChild(head);
    window.scrollTo(0, 0);
  }

  // ---------- загрузка ----------
  async function boot() {
    screen.innerHTML = "";
    if (state.auth) {
      await type("СЕАНС ВОССТАНОВЛЕН.", "dim", 8);
      await sleep(250);
      return lab();
    }
    await type("FBI-NET v2.6  (C) 1993", "dim");
    await type("СВЯЗЬ С ЛАБОРАТОРИЕЙ ..... OK");
    await type("");
    login();
  }

  // ---------- вход: игра «5 букв» ----------
  const ATTEMPTS = 5;
  const LOCKOUT_SEC = 30;
  const PASSWORD = (() => {
    const raw = Uint8Array.from(atob(D.auth), c => c.charCodeAt(0));
    const pad = enc.encode("x0510");
    return dec.decode(raw.map((b, i) => b ^ pad[i % pad.length]));
  })();
  const WORD = [...PASSWORD].length;

  // Стандартная оценка Wordle: сначала точные совпадения, затем «есть в слове» с учётом числа повторов.
  function score(guess) {
    const g = [...guess], a = [...PASSWORD];
    const res = Array(WORD).fill("miss");
    const left = {};
    a.forEach((ch, i) => { if (g[i] === ch) res[i] = "hit"; else left[ch] = (left[ch] || 0) + 1; });
    g.forEach((ch, i) => { if (res[i] !== "hit" && left[ch]) { res[i] = "near"; left[ch]--; } });
    return res;
  }

  // Строгий режим Wordle: найденные буквы обязаны остаться в следующих попытках.
  // Без него опытный игрок перебирает соседей шаблона одним словом-пробником.
  function protocolViolation(guess) {
    const g = [...guess];
    for (const prev of state.guesses) {
      const p = [...prev], sc = score(prev);
      for (let i = 0; i < WORD; i++) {
        if (sc[i] === "hit" && g[i] !== p[i]) return `ПРОТОКОЛ: ${i + 1}-Я БУКВА ДОЛЖНА БЫТЬ «${p[i]}».`;
      }
      const need = {};
      p.forEach((ch, i) => { if (sc[i] !== "miss") need[ch] = (need[ch] || 0) + 1; });
      for (const [ch, n] of Object.entries(need)) {
        if (g.filter(x => x === ch).length < n) return `ПРОТОКОЛ: В ПАРОЛЕ ДОЛЖНА БЫТЬ «${ch}».`;
      }
    }
    return null;
  }

  function login() {
    let current = "";
    let locked = false;
    if (state.guesses.length >= ATTEMPTS) state.guesses = [];
    if (!state.at.loginAt) { state.at.loginAt = now(); save(); }

    screen.appendChild(el("div", "line", "АВТОРИЗАЦИЯ"));
    screen.appendChild(el("div", "line dim", `ПАРОЛЬ: ${WORD} БУКВ · ПОПЫТОК: ${ATTEMPTS}`));
    screen.appendChild(el("div", "line dim", "РЕЖИМ: СТРОГИЙ ПРОТОКОЛ"));
    const grid = el("div", "wgrid");
    const msg = el("div", "msg");
    const kb = keyboard("ru", press);
    screen.append(grid, msg, kb);
    keyHandler = press;

    function render() {
      grid.innerHTML = "";
      const marks = {}, rank = { miss: 0, near: 1, hit: 2 };
      for (let r = 0; r < ATTEMPTS; r++) {
        const row = el("div", "wrow");
        const guess = state.guesses[r];
        const letters = guess ? [...guess] : r === state.guesses.length ? [...current] : [];
        const sc = guess ? score(guess) : null;
        for (let i = 0; i < WORD; i++) {
          row.appendChild(el("div", "wcell" + (letters[i] ? " filled" : "") + (sc ? " " + sc[i] : ""), letters[i] || ""));
          if (sc && (!marks[letters[i]] || rank[sc[i]] > rank[marks[letters[i]]])) marks[letters[i]] = sc[i];
        }
        grid.appendChild(row);
      }
      Object.entries(kb.keys).forEach(([ch, k]) => {
        k.classList.remove("hit", "near", "miss");
        if (marks[ch]) k.classList.add(marks[ch]);
      });
    }

    function press(ch) {
      if (locked || !/^[А-ЯЁ⌫⏎]$/.test(ch)) return;
      if (ch === "⌫") { current = [...current].slice(0, -1).join(""); return render(); }
      if (ch === "⏎") return submit();
      if ([...current].length < WORD) { current += ch; render(); }
    }

    async function submit() {
      if ([...current].length !== WORD) { msg.className = "msg err"; msg.textContent = `НУЖНО ${WORD} БУКВ.`; return; }
      const guess = norm(current);
      const broken = protocolViolation(guess);
      if (broken) { msg.className = "msg err"; msg.textContent = broken; buzz(120); return; }
      current = "";
      state.guesses.push(guess); save();
      render();
      msg.className = "msg"; msg.textContent = "";
      if (guess === PASSWORD) {
        buzz([30, 60, 30]);
        state.auth = true; state.guesses = []; state.at.authAt = now(); save();
        msg.textContent = "ДОСТУП РАЗРЕШЁН.";
        await sleep(800);
        return welcome();
      }
      if (state.guesses.length >= ATTEMPTS) return lockout();
      buzz(60);
      msg.className = "msg dim";
      msg.textContent = `ОСТАЛОСЬ ПОПЫТОК: ${ATTEMPTS - state.guesses.length}`;
    }

    async function lockout() {
      locked = true;
      buzz(300);
      await interference(700);
      state.lockouts++; save();
      for (let t = LOCKOUT_SEC; t > 0; t--) {
        msg.className = "msg err";
        msg.innerHTML = `ДОСТУП ЗАБЛОКИРОВАН. ПОВТОР ЧЕРЕЗ ${t} С<br><span class="warn">${D.authHint}</span>`;
        await sleep(1000);
      }
      state.guesses = []; save();
      locked = false;
      msg.className = "msg warn"; msg.textContent = D.authHint;
      render();
    }

    render();
  }

  async function welcome() {
    screen.innerHTML = "";
    const lines = [
      ["ДОПУСК: АГЕНТ Е. ЛЯДОВА .. OK", ""],
      ["", ""],
      ["ОБЪЕКТ:   ПОСЛАНИЕ", ""],
      ["НАЙДЕН:   05.10, 03:12", ""],
      ["ИСТОЧНИК: НЕ УСТАНОВЛЕН", "warn"],
      ["", ""],
      ["ОТКРЫТ ДОСТУП К ЛАБОРАТОРИИ X-0510.", ""],
    ];
    for (const [t, c] of lines) await type(t, c);
    const b = el("button", "primary full", "[ ВОЙТИ В ЛАБОРАТОРИЮ ]");
    b.onclick = lab;
    screen.appendChild(b);
  }

  // ---------- лаборатория ----------
  const MODS = D.modules;
  const isDone = m => Boolean(state.done[m.id]);
  const isOpen = (m, i) => i === 0 || isDone(MODS[i - 1]);

  async function lab() {
    view("ЛАБОРАТОРИЯ X-0510", false);
    const total = MODS.length;
    const solved = MODS.filter(isDone).length;
    const pct = Math.round(solved / total * 100);

    const bar = el("div", "bar");
    bar.innerHTML = `<span>РАСШИФРОВАНО</span><div class="track"><div class="fill" style="width:0"></div></div><b>${pct}%</b>`;
    screen.appendChild(bar);
    requestAnimationFrame(() => requestAnimationFrame(() => { bar.querySelector(".fill").style.width = pct + "%"; }));

    const clockLine = el("div", "line dim small");
    screen.appendChild(clockLine);
    const end = solved === total ? state.at[MODS[total - 1].id] : null;
    const tickLab = () => { clockLine.textContent = `ВРЕМЯ ОПЕРАЦИИ: ${fmt((end || now()) - state.at.authAt)}`; };
    tickLab();
    if (!end && state.at.authAt) ticker = setInterval(tickLab, 1000);

    const list = el("div", "mods");
    MODS.forEach((m, i) => {
      const open = isOpen(m, i), done = isDone(m);
      const gated = m.gate && !state.gates[m.id];
      const status = done ? "✓" : !open ? "—" : gated ? "🔒" : "●";
      const b = el("button", "mod" + (done ? " done" : "") + (open && !done ? " live" : ""),
        `<span class="num">${String(i + 1).padStart(2, "0")}</span>
         <span class="name">${open ? m.title : "▒▒▒▒▒▒▒▒"}<small>${open ? m.subtitle : "недоступно"}</small></span>
         <span class="st">${status}</span>`);
      b.disabled = !open;
      b.onclick = () => openModule(m);
      list.appendChild(b);
    });
    screen.appendChild(list);

    const journal = el("div", "box");
    journal.appendChild(el("div", "title", "ЖУРНАЛ ПЕРЕХВАТОВ"));
    let any = false;
    for (const m of MODS) {
      if (!isDone(m)) continue;
      any = true;
      const p = el("p", "jline");
      p.innerHTML = `<span class="dim">[${fmt(spent(m))}] ${m.title}:</span> ${await decrypt(state.done[m.id], m.message)}`;
      journal.appendChild(p);
    }
    if (!any) journal.appendChild(el("div", "dim", "ЗАПИСЕЙ НЕТ."));
    screen.appendChild(journal);

    if (solved === total) await finale();
  }

  // Время на модуль — от решения предыдущего (или от входа) до решения этого.
  function spent(m) {
    const i = MODS.indexOf(m);
    const from = i === 0 ? state.at.authAt : state.at[MODS[i - 1].id];
    return state.at[m.id] - from;
  }

  function openModule(m) {
    if (m.gate && !state.gates[m.id]) return gate(m);
    ({ decoder, crossword, simon, receiver })[m.kind](m);
  }

  async function solve(m, answer, area) {
    state.done[m.id] = answer; state.at[m.id] = now(); save();
    buzz([30, 60, 30]);
    const text = await decrypt(answer, m.message);
    const box = el("div", "box reveal");
    box.appendChild(el("div", "title", "ПЕРЕХВАТ"));
    box.appendChild(el("div", "text", text));
    const b = el("button", "primary full", "[ В ЛАБОРАТОРИЮ ]");
    b.onclick = lab;
    area.innerHTML = "";
    area.append(box, b);
    keyHandler = null;
  }

  async function showSolved(m) {
    const box = el("div", "box");
    box.appendChild(el("div", "title", "ПЕРЕХВАТ"));
    box.appendChild(el("div", "text", await decrypt(state.done[m.id], m.message)));
    screen.appendChild(box);
  }

  // ---------- код доступа к модулю ----------
  function gate(m) {
    view(m.title);
    const g = m.gate;
    screen.appendChild(el("div", "line warn", "🔒 МОДУЛЬ ЗАБЛОКИРОВАН"));
    screen.appendChild(el("div", "line", g.prompt));
    let value = "";
    const field = el("div", "codefield");
    const msg = el("div", "msg");
    const kb = keyboard(g.keys, press);
    screen.append(field, msg, kb);
    keyHandler = press;

    function render() {
      field.innerHTML = "";
      for (let i = 0; i < g.len; i++) field.appendChild(el("div", "wcell" + (value[i] ? " filled" : ""), value[i] || ""));
    }
    async function press(ch) {
      if (ch === "⌫") { value = value.slice(0, -1); return render(); }
      if (ch === "⏎") {
        if (value.length !== g.len) { msg.className = "msg err"; msg.textContent = `НУЖНО ${g.len} СИМВ.`; return; }
        if (await sha(`g|${m.id}|${norm(value)}`) === g.verify) {
          state.gates[m.id] = true; save();
          buzz([30, 60, 30]);
          msg.className = "msg"; msg.textContent = "ДОСТУП РАЗРЕШЁН.";
          await sleep(600);
          return openModule(m);
        }
        buzz(200); shake(); await interference(400);
        msg.className = "msg err"; msg.textContent = "КОД НЕ ПРИНЯТ.";
        value = ""; return render();
      }
      const ok = g.keys === "digits" ? /^[0-9]$/.test(ch) : /^[А-Я]$/.test(ch);
      if (ok && value.length < g.len) { value += ch; render(); }
    }
    render();
  }

  // ---------- дешифратор символов ----------
  function decoder(m) {
    view(m.title);
    if (isDone(m)) return showSolved(m);
    const total = m.patterns.reduce((a, b) => a + b, 0);
    const seq = state.input[m.id] = state.input[m.id] || [];

    screen.appendChild(el("div", "line dim", "&gt; ВВЕДИТЕ СИМВОЛЫ ОБЪЕКТА"));
    const area = el("div");
    const box = el("div", "box");
    box.appendChild(el("div", "title", `ОБЪЕКТ · ${m.patterns.length} УЗОРА`));
    const slots = el("div", "slots");
    slots.style.gridTemplateColumns = `repeat(${m.patterns.length}, 1fr)`;
    box.appendChild(slots);
    const counter = el("div", "line dim");
    const msg = el("div", "msg");
    const kb = keyboard("jamo", press);
    area.append(box, counter, kb, msg);
    screen.appendChild(area);
    keyHandler = ch => { if (ch === "⌫" || ch === "⏎") press(ch); };

    function render() {
      slots.innerHTML = "";
      let k = 0;
      m.patterns.forEach(size => {
        const p = el("div", "pattern");
        for (let i = 0; i < size; i++, k++) {
          p.appendChild(el("div", "cell" + (seq[k] ? " filled" : "") + (k === seq.length ? " next" : ""), seq[k] || ""));
        }
        slots.appendChild(p);
      });
      counter.textContent = `ВВЕДЕНО: ${seq.length}/${total}`;
    }

    async function press(ch) {
      if (ch === "⌫") { seq.pop(); save(); return render(); }
      if (ch !== "⏎") { if (seq.length < total) { seq.push(ch); save(); render(); } return; }
      if (seq.length !== total) { msg.className = "msg err"; msg.textContent = `НУЖНО ${total} СИМВОЛОВ.`; return; }
      msg.className = "msg"; msg.textContent = "АНАЛИЗ…";
      const answer = seq.join("");
      if (await sha(`v|${m.id}|${answer}`) === m.verify) return solve(m, answer, area);
      let hits = 0;
      for (let i = 0; i < total; i++) if (await sha(`p|${m.id}|${i}|${seq[i]}`) === m.positions[i]) hits++;
      state.fails[m.id] = (state.fails[m.id] || 0) + 1; save();
      buzz(200); shake(); await interference();
      const f = state.fails[m.id];
      const hint = f >= 4 ? m.hints[1] : f >= 2 ? m.hints[0] : "";
      msg.className = "msg err";
      msg.innerHTML = `СТРУКТУРА НЕ РАСПОЗНАНА. СОВПАДЕНИЕ: ${hits}/${total}` + (hint ? `<br><span class="warn">${hint}</span>` : "");
    }

    render();
  }

  // ---------- кроссворд ----------
  function crossword(m) {
    view(m.title);
    if (isDone(m)) return showSolved(m);
    const st = state.input[m.id] = state.input[m.id] || { typed: m.rows.map(() => ""), solved: m.rows.map(() => null), sel: 0 };

    const area = el("div");
    const grid = el("div", "xgrid");
    grid.style.gridTemplateColumns = `repeat(${m.cols}, minmax(0, 1fr))`;
    const clue = el("div", "xclue");
    const prev = el("button", "", "◂"), next = el("button", "", "▸");
    const clueText = el("div", "ctext");
    clue.append(prev, clueText, next);
    const msg = el("div", "msg");
    const kb = keyboard("ru", press);
    area.append(grid, clue, kb, msg);
    screen.appendChild(area);
    keyHandler = press;

    prev.onclick = () => select(-1);
    next.onclick = () => select(1);

    function select(d) {
      for (let i = 1; i <= m.rows.length; i++) {
        const j = (st.sel + d * i + m.rows.length * 10) % m.rows.length;
        if (!st.solved[j]) { st.sel = j; break; }
      }
      save(); render();
    }

    function render() {
      grid.innerHTML = "";
      m.rows.forEach((row, r) => {
        const word = st.solved[r] || st.typed[r];
        for (let c = 0; c < m.cols; c++) {
          const i = c - row.start;
          if (i < 0 || i >= row.len) { grid.appendChild(el("div", "xc void")); continue; }
          const cls = ["xc"];
          if (c === m.keyCol) cls.push("kcol");
          if (st.solved[r]) cls.push("ok");
          else if (r === st.sel) cls.push("sel");
          if (r === st.sel && !st.solved[r] && i === [...st.typed[r]].length) cls.push("next");
          const cell = el("div", cls.join(" "), [...word][i] || "");
          if (i === 0) cell.dataset.n = r + 1;
          cell.onclick = () => { if (!st.solved[r]) { st.sel = r; save(); render(); } };
          grid.appendChild(cell);
        }
      });
      const row = m.rows[st.sel];
      clueText.innerHTML = `<b>${st.sel + 1}.</b> ${row.clue} <span class="dim">(${row.len})</span>`;
    }

    async function press(ch) {
      if (!/^[А-Я⌫⏎]$/.test(ch)) return;
      const r = st.sel;
      if (st.solved[r]) return;
      const row = m.rows[r];
      const letters = [...st.typed[r]];
      if (ch === "⌫") { letters.pop(); st.typed[r] = letters.join(""); save(); return render(); }
      if (ch !== "⏎" && letters.length < row.len) { letters.push(ch); st.typed[r] = letters.join(""); save(); render(); }
      if (letters.length === row.len) await check(r);
    }

    async function check(r) {
      const word = st.typed[r];
      if (await sha(`w|${m.id}|${r}|${word}`) === m.rows[r].verify) {
        st.solved[r] = word; save();
        buzz([20, 40, 20]);
        msg.className = "msg"; msg.textContent = "ЗАПИСЬ ПОДТВЕРЖДЕНА.";
        if (st.solved.every(Boolean)) {
          render();
          const key = st.solved.map((w, i) => [...w][m.keyCol - m.rows[i].start]).join("");
          msg.innerHTML = `КЛЮЧЕВОЙ СТОЛБЕЦ: <b>${key}</b>`;
          await sleep(1400);
          return solve(m, key, area);
        }
        return select(1);
      }
      buzz(150); shake();
      msg.className = "msg err"; msg.textContent = "ЗАПИСЬ НЕ НАЙДЕНА В КАРТОТЕКЕ.";
      st.typed[r] = ""; save(); render();
    }

    if (st.solved[st.sel]) select(1); else render();
  }

  // ---------- контакт: повторить мелодию ----------
  function simon(m) {
    view(m.title);
    if (isDone(m)) return showSolved(m);
    const area = el("div");
    area.appendChild(el("div", "line", "ОБЪЕКТ ПЕРЕДАЁТ ПОЗЫВНОЙ. ПОВТОРИТЕ ЕГО, ЧТОБЫ ПОДТВЕРДИТЬ КОНТАКТ."));
    area.appendChild(el("div", "line warn small", "🔊 ВКЛЮЧИТЕ ЗВУК И СНИМИТЕ БЕЗЗВУЧНЫЙ РЕЖИМ"));
    const pads = el("div", "pads");
    const padEls = m.notes.map((f, i) => {
      const p = el("button", "pad", `<span>${"•".repeat(i + 1)}</span>`);
      p.onclick = () => hit(i);
      pads.appendChild(p);
      return p;
    });
    const status = el("div", "line center");
    const start = el("button", "primary full", "[ ▶ ПРИНЯТЬ ПОЗЫВНОЙ ]");
    const msg = el("div", "msg");
    area.append(pads, status, start, msg);
    screen.appendChild(area);

    let round = 0, pos = 0, listening = false;
    const seq = m.sequence;

    async function flash(i, ms = 420) {
      padEls[i].classList.add("on");
      tone(m.notes[i], ms);
      buzz(40);
      await sleep(ms);
      padEls[i].classList.remove("on");
    }
    async function play() {
      listening = false;
      start.disabled = true;
      status.textContent = `ПРИЁМ… ${round}/${seq.length}`;
      await sleep(500);
      for (let i = 0; i < round; i++) { await flash(seq[i]); await sleep(160); }
      status.textContent = "ВАШ ОТВЕТ";
      pos = 0; listening = true;
    }
    async function hit(i) {
      if (!listening) return;
      flash(i, 260);
      if (i !== seq[pos]) {
        listening = false;
        buzz(250); await interference(500);
        msg.className = "msg err"; msg.textContent = "СБОЙ КОНТАКТА. ПОВТОР ПОЗЫВНОГО.";
        return play();
      }
      pos++;
      if (pos < round) return;
      msg.textContent = "";
      if (round < seq.length) { round++; await sleep(500); return play(); }
      listening = false;
      status.textContent = "КОНТАКТ ПОДТВЕРЖДЁН";
      await sleep(600);
      solve(m, seq.join(""), area);
    }
    start.onclick = () => { round = 1; msg.textContent = ""; play(); };
  }

  // ---------- приёмник: тумблеры + морзянка ----------
  const MORSE_TABLE = "А .- Б -... В .-- Г --. Д -.. Е . Ж ...- З --.. И .. Й .--- К -.- Л .-.. М -- Н -. О --- П .--. Р .-. С ... Т - У ..- Ф ..-. Х .... Ц -.-. Ч ---. Ш ---- Щ --.- Ъ --.-- Ы -.-- Ь -..- Э ..-.. Ю ..-- Я .-.-";

  function receiver(m) {
    view(m.title);
    if (isDone(m)) return showSolved(m);
    const area = el("div");
    screen.appendChild(area);
    if (state.tuned[m.id]) return listen();

    area.appendChild(el("div", "line", "ЗАДАЙТЕ ЧАСТОТУ ПРИЁМА"));
    const dials = el("div", "dials");
    const vals = Array(m.tuneLen).fill(0);
    vals.forEach((_, i) => {
      const d = el("div", "dialv");
      const up = el("button", "", "▲"), down = el("button", "", "▼");
      const out = el("output", "", "0");
      const set = delta => { vals[i] = (vals[i] + delta + 10) % 10; out.textContent = vals[i]; buzz(5); tone(300 + vals[i] * 40, 40, .06); };
      up.onclick = () => set(1); down.onclick = () => set(-1);
      d.append(up, out, down);
      dials.appendChild(d);
    });
    dials.appendChild(el("div", "unit", "МГц"));
    const go = el("button", "primary full", "[ НАСТРОИТЬ ]");
    const msg = el("div", "msg");
    area.append(dials, go, msg);

    go.onclick = async () => {
      const code = vals.join("");
      if (await sha(`t|${m.id}|${code}`) === m.tuneVerify) {
        state.tuned[m.id] = code; save();
        buzz([30, 60, 30]);
        msg.className = "msg"; msg.textContent = "СИГНАЛ ЗАХВАЧЕН.";
        await sleep(700);
        area.innerHTML = "";
        return listen();
      }
      buzz(200);
      for (let i = 0; i < 6; i++) tone(120 + Math.random() * 900, 70, .05);
      await interference(700);
      msg.className = "msg err"; msg.textContent = `${code} МГц: ТОЛЬКО ШУМ.`;
    };

    async function listen() {
      const code = state.tuned[m.id];
      const morse = await decrypt(code, m.morse);
      area.appendChild(el("div", "line", `ЧАСТОТА ${code} МГц · СИГНАЛ ЗАХВАЧЕН`));
      const lamp = el("div", "lamp");
      const play = el("button", "primary full", "[ ▶ ВОСПРОИЗВЕСТИ СИГНАЛ ]");
      area.append(lamp, play);
      area.appendChild(el("div", "line dim small", "ВВЕДИТЕ РАСШИФРОВАННОЕ СЛОВО"));
      let value = "";
      const field = el("div", "wordfield");
      const msg2 = el("div", "msg");
      const kb = keyboard("ru", press);
      area.append(field, kb, msg2);
      keyHandler = press;

      const U = 120;
      let playing = false;
      play.onclick = async () => {
        if (playing) return;
        playing = true; play.disabled = true;
        for (let rep = 0; rep < 2; rep++) {
          for (const ch of morse) {
            if (ch === " ") { await sleep(U * 5); continue; }
            const len = ch === "." ? U : U * 3;
            lamp.classList.add("on"); tone(600, len, .2); buzz(len);
            await sleep(len);
            lamp.classList.remove("on");
            await sleep(U);
          }
          await sleep(U * 12);
        }
        playing = false; play.disabled = false;
      };

      function render() { field.textContent = value || "_"; }
      async function press(ch) {
        if (!/^[А-Я⌫⏎]$/.test(ch)) return;
        if (ch === "⌫") { value = [...value].slice(0, -1).join(""); return render(); }
        if (ch !== "⏎") { if ([...value].length < 12) { value += ch; render(); } return; }
        if (!value) return;
        const answer = norm(value);
        if (await sha(`v|${m.id}|${answer}`) === m.verify) return solve(m, answer, area);
        state.fails[m.id] = (state.fails[m.id] || 0) + 1; save();
        buzz(200); shake(); await interference(400);
        msg2.className = "msg err";
        msg2.innerHTML = "СЛОВО НЕ СОВПАДАЕТ С СИГНАЛОМ." +
          (state.fails[m.id] >= 2 ? `<br><span class="warn">${m.hints[0]}</span>` : "") +
          (state.fails[m.id] >= 5 ? `<br><span class="warn small">${MORSE_TABLE}</span>` : "");
        value = ""; render();
      }
      render();
    }
  }

  async function finale() {
    const f = el("div", "final reveal");
    f.innerHTML = `
      <div class="warn">РАСШИФРОВКА ЗАВЕРШЕНА</div>
      <div class="big">КОНТАКТ УСТАНОВЛЕН</div>
      <div class="dim">ДЕЛО X-0510 · ПЕРЕДАНО СПЕЦ. АГЕНТУ Е. ЛЯДОВОЙ</div>`;
    screen.appendChild(f);

    const a = state.at, last = a[MODS[MODS.length - 1].id];
    const rows = [["ВХОД (5 БУКВ)", a.authAt - a.loginAt], ...MODS.map(m => [m.title, spent(m)])];
    const report = el("div", "box");
    report.appendChild(el("div", "title", "ОТЧЁТ О ВРЕМЕНИ"));
    report.innerHTML += rows.map(([n, ms]) => `<div class="trow"><span>${n}</span><span>${fmt(ms)}</span></div>`).join("") +
      `<div class="trow total"><span>ИТОГО ПОСЛЕ ВХОДА</span><span>${fmt(last - a.authAt)}</span></div>` +
      `<div class="trow total"><span>ИТОГО С НАЧАЛА</span><span>${fmt(last - a.loginAt)}</span></div>`;
    screen.appendChild(report);
  }

  // ---------- служебное ----------
  const clock = document.getElementById("clock");
  const tick = () => { clock.textContent = new Date().toLocaleTimeString("ru-RU"); };
  tick(); setInterval(tick, 1000);

  // Скрытый сброс для прогона квеста: удерживать шапку 3 секунды.
  let hold;
  const logo = document.getElementById("logo");
  const startHold = () => { hold = setTimeout(() => {
    if (confirm("Сбросить прогресс дела X-0510?")) { try { localStorage.removeItem(STORE); } catch (_) {} location.reload(); }
  }, 3000); };
  const stopHold = () => clearTimeout(hold);
  logo.addEventListener("touchstart", startHold, { passive: true });
  logo.addEventListener("mousedown", startHold);
  ["touchend", "touchcancel", "mouseup", "mouseleave"].forEach(e => logo.addEventListener(e, stopHold));

  boot();
})();
