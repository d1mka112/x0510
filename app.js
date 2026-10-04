(() => {
  const D = window.X0510;
  const STORE = "x0510-state";
  const KEYBOARD = [
    ["ㅂ", "ㅈ", "ㄷ", "ㄱ", "ㅅ", "ㅛ", "ㅕ", "ㅑ", "ㅐ", "ㅔ"],
    ["ㅁ", "ㄴ", "ㅇ", "ㄹ", "ㅎ", "ㅗ", "ㅓ", "ㅏ", "ㅣ"],
    ["ㅋ", "ㅌ", "ㅊ", "ㅍ", "ㅠ", "ㅜ", "ㅡ"],
  ];
  const TOTAL = D.patterns.reduce((a, b) => a + b, 0);
  const SETTINGS = [
    { layer: 1, name: "ЧАСТОТА", kind: "freq" },
    { layer: 2, name: "ПОВОРОТ", kind: "dial" },
    { layer: 3, name: "КЛЮЧ", kind: "text" },
  ];

  const screen = document.getElementById("screen");
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  // Состояние живёт в localStorage, чтобы квест переживал перезагрузку и закрытие вкладки.
  // answers[i] хранит сам ответ: без него не расшифровать слой i после перезагрузки.
  let state = load();

  function load() {
    try {
      const s = JSON.parse(localStorage.getItem(STORE));
      if (s && Array.isArray(s.answers)) return s;
    } catch (_) {}
    return { answers: [null, null, null, null], seq: [], fails: 0, booted: false, auth: false, guesses: [] };
  }
  function save() {
    try { localStorage.setItem(STORE, JSON.stringify(state)); } catch (_) {}
  }

  async function sha(s) {
    const buf = await crypto.subtle.digest("SHA-256", enc.encode(s));
    return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
  }
  async function decrypt(secret, b64) {
    const data = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const out = new Uint8Array(data.length);
    let stream = new Uint8Array(0), i = 0;
    while (stream.length < data.length) {
      const block = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(`k|${secret}|${i++}`)));
      const next = new Uint8Array(stream.length + block.length);
      next.set(stream); next.set(block, stream.length);
      stream = next;
    }
    for (let j = 0; j < data.length; j++) out[j] = data[j] ^ stream[j];
    return dec.decode(out);
  }

  const normalize = {
    freq: v => {
      const n = parseFloat(String(v).replace(",", ".").replace(/[^0-9.]/g, ""));
      return Number.isFinite(n) ? n.toFixed(2) : "";
    },
    dial: v => String(((Number(v) % 360) + 360) % 360),
    text: v => String(v).toUpperCase().replace(/Ё/g, "Е").replace(/[^A-ZА-Я]/g, ""),
  };

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const el = (tag, cls, html) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  };
  const buzz = p => { try { navigator.vibrate && navigator.vibrate(p); } catch (_) {} };

  async function type(line, cls = "", speed = 14) {
    const p = el("div", "line cursor " + cls);
    screen.appendChild(p);
    for (const ch of line) {
      p.textContent += ch;
      if (ch !== " ") await sleep(speed);
    }
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

  // ---------- загрузка ----------
  async function boot() {
    screen.innerHTML = "";
    if (state.booted) {
      await type("СЕАНС ВОССТАНОВЛЕН.", "dim", 8);
      await sleep(250);
      return state.answers[0] ? decoder() : inputScreen();
    }
    if (!state.auth) {
      await type("FBI-NET v2.6  (C) 1993", "dim");
      await type("СВЯЗЬ С ЛАБОРАТОРИЕЙ ..... OK");
      await type("");
      return login();
    }
    const lines = [
      ["FBI-NET v2.6  (C) 1993", "dim"],
      ["СВЯЗЬ С ЛАБОРАТОРИЕЙ ..... OK", ""],
      ["ДОПУСК: АГЕНТ Е. ЛЯДОВА .. OK", ""],
      ["", ""],
      ["ОБЪЕКТ:   ТАБЛИЧКА", ""],
      ["НАЙДЕН:   КУХНЯ, 05.10, 03:12", ""],
      ["ИСТОЧНИК: НЕ УСТАНОВЛЕН", "warn"],
      ["", ""],
      ["ВНЕСИТЕ СИМВОЛЫ ОБЪЕКТА.", ""],
    ];
    for (const [t, c] of lines) await type(t, c);
    const b = el("button", "primary", "[ НАЧАТЬ АНАЛИЗ ]");
    b.style.marginTop = "16px"; b.style.width = "100%";
    b.onclick = () => { state.booted = true; save(); inputScreen(); };
    screen.appendChild(b);
  }

  // ---------- авторизация: игра «5 букв» ----------
  const RU_KEYBOARD = [
    ["Й", "Ц", "У", "К", "Е", "Н", "Г", "Ш", "Щ", "З", "Х", "Ъ"],
    ["Ф", "Ы", "В", "А", "П", "Р", "О", "Л", "Д", "Ж", "Э"],
    ["⌫", "Я", "Ч", "С", "М", "И", "Т", "Ь", "Б", "Ю", "⏎"],
  ];
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

  function login() {
    state.guesses = state.guesses || [];
    let current = "";

    const head = el("div");
    head.appendChild(el("div", "line", "АВТОРИЗАЦИЯ"));
    head.appendChild(el("div", "line dim", `ПАРОЛЬ: ${WORD} БУКВ · ПОПЫТОК: ${ATTEMPTS}`));
    head.appendChild(el("div", "line dim", "РЕЖИМ: СТРОГИЙ ПРОТОКОЛ"));
    screen.appendChild(head);

    const grid = el("div", "wgrid");
    screen.appendChild(grid);
    const msg = el("div", "msg");
    screen.appendChild(msg);

    const kb = el("div", "kbd");
    const keyEls = {};
    RU_KEYBOARD.forEach(row => {
      const r = el("div", "krow");
      row.forEach(ch => {
        const wide = ch === "⌫" || ch === "⏎";
        const k = el("button", "key ru" + (wide ? " wide" : ""), ch === "⏎" ? "ВХОД" : ch);
        k.onclick = () => press(ch);
        keyEls[ch] = k;
        r.appendChild(k);
      });
      kb.appendChild(r);
    });
    screen.appendChild(kb);

    let locked = false;

    function render() {
      grid.innerHTML = "";
      const marks = {};
      for (let r = 0; r < ATTEMPTS; r++) {
        const row = el("div", "wrow");
        const guess = state.guesses[r];
        const letters = guess ? [...guess] : r === state.guesses.length ? [...current] : [];
        const sc = guess ? score(guess) : null;
        for (let i = 0; i < WORD; i++) {
          const cell = el("div", "wcell" + (letters[i] ? " filled" : "") + (sc ? " " + sc[i] : ""), letters[i] || "");
          row.appendChild(cell);
          if (sc) {
            const prev = marks[letters[i]];
            const rank = { miss: 0, near: 1, hit: 2 };
            if (!prev || rank[sc[i]] > rank[prev]) marks[letters[i]] = sc[i];
          }
        }
        grid.appendChild(row);
      }
      Object.entries(keyEls).forEach(([ch, k]) => { k.classList.remove("hit", "near", "miss"); if (marks[ch]) k.classList.add(marks[ch]); });
    }

    async function press(ch) {
      if (locked) return;
      if (ch === "⌫") { current = [...current].slice(0, -1).join(""); return render(); }
      if (ch === "⏎") return submit();
      if ([...current].length < WORD) { current += ch; buzz(5); render(); }
    }

    async function submit() {
      if ([...current].length !== WORD) { msg.className = "msg err"; msg.textContent = `НУЖНО ${WORD} БУКВ.`; return; }
      const guess = current.replace(/Ё/g, "Е");
      const broken = protocolViolation(guess);
      if (broken) { msg.className = "msg err"; msg.textContent = broken; buzz(120); return; }
      current = "";
      state.guesses.push(guess); save();
      render();
      msg.className = "msg"; msg.textContent = "";
      if (guess === PASSWORD) {
        buzz([30, 60, 30]);
        state.auth = true; state.guesses = []; save();
        msg.textContent = "ДОСТУП РАЗРЕШЁН.";
        await sleep(900);
        return boot();
      }
      if (state.guesses.length >= ATTEMPTS) return lockout();
      buzz(60);
      msg.className = "msg dim";
      msg.textContent = `ОСТАЛОСЬ ПОПЫТОК: ${ATTEMPTS - state.guesses.length}`;
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

    async function lockout() {
      locked = true;
      buzz(300);
      await interference(700);
      state.lockouts = (state.lockouts || 0) + 1; save();
      for (let t = LOCKOUT_SEC; t > 0; t--) {
        msg.className = "msg err";
        msg.innerHTML = `ДОСТУП ЗАБЛОКИРОВАН. ПОВТОР ЧЕРЕЗ ${t} С` +
          (state.lockouts >= 1 ? `<br><span class="warn">${D.authHint}</span>` : "");
        await sleep(1000);
      }
      state.guesses = []; save();
      locked = false;
      msg.className = "msg warn"; msg.textContent = D.authHint;
      render();
    }

    document.onkeydown = e => {
      if (!screen.contains(grid)) { document.onkeydown = null; return; }
      if (e.key === "Backspace") press("⌫");
      else if (e.key === "Enter") press("⏎");
      else if (/^[а-яё]$/i.test(e.key)) press(e.key.toUpperCase());
    };

    if (state.guesses.length >= ATTEMPTS) state.guesses = [];
    render();
  }

  // ---------- ввод символов ----------
  function inputScreen() {
    screen.innerHTML = "";
    screen.appendChild(el("div", "line dim", "&gt; ВВОД СИМВОЛОВ ОБЪЕКТА"));

    const box = el("div", "box");
    box.appendChild(el("div", "title", "ОБЪЕКТ · 4 УЗОРА"));
    const slots = el("div", "slots");
    box.appendChild(slots);
    screen.appendChild(box);

    const counter = el("div", "line dim");
    screen.appendChild(counter);

    const kb = el("div", "kbd");
    KEYBOARD.forEach(row => {
      const r = el("div", "krow");
      row.forEach(ch => {
        const k = el("button", "key", ch);
        k.onclick = () => { if (state.seq.length < TOTAL) { state.seq.push(ch); save(); buzz(8); render(); } };
        r.appendChild(k);
      });
      kb.appendChild(r);
    });
    screen.appendChild(kb);

    const actions = el("div", "row");
    const back = el("button", "", "⌫ СТЕРЕТЬ");
    const clear = el("button", "", "ОЧИСТИТЬ");
    const go = el("button", "primary", "АНАЛИЗ ▸");
    back.onclick = () => { state.seq.pop(); save(); render(); };
    clear.onclick = () => { state.seq = []; save(); render(); };
    go.onclick = analyse;
    actions.append(back, clear, go);
    screen.appendChild(actions);

    const msg = el("div", "msg");
    screen.appendChild(msg);

    function render() {
      slots.innerHTML = "";
      let k = 0;
      D.patterns.forEach(size => {
        const p = el("div", "pattern");
        for (let i = 0; i < size; i++, k++) {
          const ch = state.seq[k];
          p.appendChild(el("div", "cell" + (ch ? " filled" : "") + (k === state.seq.length ? " next" : ""), ch || ""));
        }
        slots.appendChild(p);
      });
      counter.textContent = `ВВЕДЕНО: ${state.seq.length}/${TOTAL}`;
      go.disabled = state.seq.length !== TOTAL;
    }

    async function analyse() {
      go.disabled = true;
      msg.className = "msg"; msg.textContent = "АНАЛИЗ…";
      const seq = state.seq.join("");
      if (await sha(`v|0|${seq}`) === D.verify[0]) {
        state.answers[0] = seq; save();
        buzz([30, 60, 30]);
        msg.textContent = "СТРУКТУРА РАСПОЗНАНА.";
        await sleep(700);
        return decoder(true);
      }
      let hits = 0;
      for (let i = 0; i < TOTAL; i++) if (await sha(`p|${i}|${state.seq[i]}`) === D.positions[i]) hits++;
      state.fails++; save();
      buzz(200);
      screen.classList.add("shake"); setTimeout(() => screen.classList.remove("shake"), 400);
      await interference();
      msg.className = "msg err";
      msg.innerHTML = `СТРУКТУРА НЕ РАСПОЗНАНА. СОВПАДЕНИЕ: ${hits}/${TOTAL}` + hintFor(state.fails);
      go.disabled = false;
    }

    render();
  }

  function hintFor(fails) {
    if (fails >= 4) return `<br><span class="warn">АГЕНТ МАЛДЕР: «Скалли, а если поднести табличку к зеркалу?»</span>`;
    if (fails >= 2) return `<br><span class="warn">АГЕНТ МАЛДЕР: «Похоже, они пишут с той стороны».</span>`;
    return "";
  }

  // ---------- дешифратор ----------
  async function decoder(fresh = false) {
    screen.innerHTML = "";
    const solved = state.answers.map(Boolean);
    const level = solved.lastIndexOf(true) >= 0 ? solved.filter(Boolean).length - 1 : -1;
    const pct = solved.reduce((p, ok, i) => (ok ? Math.max(p, D.progress[i]) : p), 0);

    screen.appendChild(el("div", "line dim", "&gt; ДЕШИФРАТОР X-0510"));

    const bar = el("div", "bar");
    bar.innerHTML = `<span>РАСШИФРОВАНО</span><div class="track"><div class="fill" style="width:0"></div></div><b>${pct}%</b>`;
    screen.appendChild(bar);
    requestAnimationFrame(() => requestAnimationFrame(() => { bar.querySelector(".fill").style.width = pct + "%"; }));

    const box = el("div", "box");
    box.appendChild(el("div", "title", "ПЕРЕВОД"));
    const text = el("div", "text");
    for (const c of D.chunks) {
      const span = el("span");
      if (state.answers[c.layer]) {
        span.textContent = await decrypt(state.answers[c.layer], c.enc);
        if (fresh && c.layer === level) span.className = "reveal";
      } else {
        span.className = "redact";
        span.textContent = "█".repeat(c.len);
      }
      text.append(span, " ");
    }
    box.appendChild(text);
    screen.appendChild(box);

    if (solved.every(Boolean)) return finale(fresh);

    const panel = el("div", "box");
    panel.appendChild(el("div", "title", "КАЛИБРОВКА"));
    const inputs = {};
    SETTINGS.forEach(s => {
      const done = Boolean(state.answers[s.layer]);
      const row = el("div", "setting");
      row.appendChild(el("label", "", "⚙ " + s.name));
      row.appendChild(el("span", "state " + (done ? "" : "dim"), done ? "✓ ОТКАЛИБРОВАНО" : "НЕ ЗАДАНО"));
      const ctrl = el("div", "ctrl");
      if (s.kind === "dial") {
        let v = done ? Number(state.answers[s.layer]) : 0;
        const dial = el("div", "dial");
        const minus = el("button", "", "◂");
        const out = el("output", "", v + "°");
        const plus = el("button", "", "▸");
        const set = d => { v = (v + d + 360) % 360; out.textContent = v + "°"; buzz(5); };
        minus.onclick = () => set(-15); plus.onclick = () => set(15);
        minus.disabled = plus.disabled = done;
        dial.append(minus, out, plus);
        ctrl.appendChild(dial);
        inputs[s.layer] = () => (v === 0 ? "" : v);
      } else {
        const inp = el("input");
        inp.disabled = done;
        inp.value = done ? state.answers[s.layer] : "";
        inp.autocomplete = "off"; inp.spellcheck = false;
        if (s.kind === "freq") { inp.inputMode = "decimal"; inp.placeholder = "000.00"; }
        else inp.placeholder = "______";
        ctrl.appendChild(inp);
        if (s.kind === "freq") ctrl.appendChild(el("span", "unit", "МГц"));
        inputs[s.layer] = () => inp.value.trim();
      }
      row.appendChild(ctrl);
      panel.appendChild(row);
    });
    screen.appendChild(panel);

    const go = el("button", "primary", "[ ПЕРЕКАЛИБРОВАТЬ ]");
    go.style.width = "100%";
    screen.appendChild(go);
    const msg = el("div", "msg");
    screen.appendChild(msg);

    go.onclick = async () => {
      go.disabled = true;
      let gained = false, tried = false;
      for (const s of SETTINGS) {
        if (state.answers[s.layer]) continue;
        const raw = inputs[s.layer]();
        if (raw === "" || raw == null) continue;
        tried = true;
        const v = normalize[s.kind](raw);
        if (await sha(`v|${s.layer}|${v}`) === D.verify[s.layer]) { state.answers[s.layer] = v; gained = true; }
      }
      save();
      if (gained) {
        buzz([30, 60, 30]);
        msg.className = "msg"; msg.textContent = "КАЛИБРОВКА ПРИНЯТА. ПЕРЕСЧЁТ…";
        await interference(350);
        return decoder(true);
      }
      buzz(200);
      await interference();
      msg.className = "msg err";
      msg.textContent = tried ? "ПОМЕХИ. ПАРАМЕТРЫ НЕ ПОДОШЛИ." : "ЗАДАЙТЕ ХОТЯ БЫ ОДИН ПАРАМЕТР.";
      go.disabled = false;
    };
  }

  async function finale(fresh) {
    const f = el("div", "final");
    screen.appendChild(f);
    if (fresh) { buzz([40, 80, 40, 80, 200]); await sleep(900); }
    f.innerHTML = `
      <div class="warn">РАСШИФРОВКА ЗАВЕРШЕНА</div>
      <div class="big">КОНТАКТ УСТАНОВЛЕН</div>
      <div class="dim">ДЕЛО X-0510 · ПЕРЕДАНО СПЕЦ. АГЕНТУ Е. ЛЯДОВОЙ</div>`;
  }

  // ---------- служебное ----------
  const clock = document.getElementById("clock");
  const tick = () => { clock.textContent = new Date().toLocaleTimeString("ru-RU"); };
  tick(); setInterval(tick, 1000);

  // Скрытый сброс для прогона квеста: удерживать шапку 3 секунды.
  let hold;
  const logo = document.getElementById("logo");
  const start = () => { hold = setTimeout(() => {
    if (confirm("Сбросить прогресс дела X-0510?")) { try { localStorage.removeItem(STORE); } catch (_) {} location.reload(); }
  }, 3000); };
  const stop = () => clearTimeout(hold);
  logo.addEventListener("touchstart", start, { passive: true });
  logo.addEventListener("mousedown", start);
  ["touchend", "touchcancel", "mouseup", "mouseleave"].forEach(e => logo.addEventListener(e, stop));

  boot();
})();
