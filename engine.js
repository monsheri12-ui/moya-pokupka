(function (root) {
  'use strict';
  const copy = value => JSON.parse(JSON.stringify(value));
  const shuffle = (list, rng) => {
    const out = [...list];
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  };
  const signature = items => items.slice().sort((a, b) => a.product_id.localeCompare(b.product_id))
    .map(item => item.product_id + ':' + item.quantity).join('|');
  const parseAmount = raw => {
    const text = String(raw).trim();
    if (!/^\d+(?:[ \u00a0\u202f]\d{3})*$/.test(text)) return null;
    const value = Number(text.replace(/[ \u00a0\u202f]/g, ''));
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  };
  const ONES = ['', 'нэг', 'хоёр', 'гурван', 'дөрвөн', 'таван', 'зургаан', 'долоон', 'найман', 'есөн'];
  const TENS = ['', 'арван', 'хорин', 'гучин', 'дөчин', 'тавин', 'жаран', 'далан', 'наян', 'ерэн'];
  function numberWords(n) {
    if (!Number.isInteger(n) || n < 1 || n >= 1000) throw new Error('Unsupported number');
    if (n < 10) return ONES[n];
    if (n < 100) {
      const u = n % 10;
      return TENS[Math.floor(n / 10)] + (u ? ' ' + (u === 1 ? 'нэгэн' : ONES[u]) : '');
    }
    return ONES[Math.floor(n / 100)] + ' зуун' + (n % 100 ? ' ' + numberWords(n % 100) : '');
  }
  function amountWords(n) {
    if (!Number.isInteger(n) || n < 50 || n % 50) throw new Error('Unsupported amount');
    const thousands = Math.floor(n / 1000), remainder = n % 1000;
    if (!thousands) return numberWords(remainder) + ' төгрөг';
    return numberWords(thousands) + (remainder ? ' мянга ' + numberWords(remainder) : ' мянган') + ' төгрөг';
  }
  function amountSentence(n) {
    const words = amountWords(n);
    return n < 52000 ? 'Нийт ' + words + '.' : words[0].toUpperCase() + words.slice(1) + '.';
  }
  function amountKeys(n) {
    const thousands = Math.floor(n / 1000), remainder = n % 1000;
    if (!thousands) return ['remainder/' + remainder];
    if (!remainder) return ['thousands/' + thousands + '-whole'];
    return ['thousands/' + thousands + '-part', 'remainder/' + remainder];
  }

  class Game {
    constructor(content, saved = null, rng = Math.random) {
      this.content = content;
      this.rng = rng;
      this.products = new Map(content.products.map(p => [p.id, p]));
      this.own = new Map(content.own_baskets.map(b => [b.id, b]));
      this.foreign = new Map(content.foreign_baskets.map(b => [b.id, b]));
      if (saved) {
        if (saved.version !== 2 || !Array.isArray(saved.remainingOwn) || !Array.isArray(saved.remainingForeign)) throw new Error('Invalid save');
        if (new Set(saved.remainingOwn).size !== saved.remainingOwn.length || saved.remainingOwn.some(id => !this.own.has(id))) throw new Error('Invalid own deck');
        if (new Set(saved.remainingForeign).size !== saved.remainingForeign.length || saved.remainingForeign.some(id => !this.foreign.has(id))) throw new Error('Invalid foreign deck');
        this.state = copy(saved);
      } else {
        this.state = {
          version: 2, cycle: 1,
          remainingOwn: shuffle([...this.own.keys()], rng),
          remainingForeign: shuffle([...this.foreign.keys()], rng),
          lastPrices: {}, lastTotal: null, active: null, history: [],
          stats: {collected: 0, clean: 0, withErrors: 0, foreignRecognized: 0, foreignMistakes: 0},
          settings: {level: 2, speed: 1, labels: false}
        };
      }
    }
    snapshot() { return copy(this.state); }
    get active() { return this.state.active; }
    get event() { return this.active ? this.active.events[this.active.eventIndex] : null; }
    remaining(level = 0) {
      return this.state.remainingOwn.filter(id => !level || this.own.get(id).difficulty === level).length;
    }
    startVisit(options = {}) {
      if (this.active && this.active.phase !== 'collected') return {ok: true, resumed: true};
      const level = options.level === undefined ? this.state.settings.level : options.level;
      const index = this.state.remainingOwn.findIndex(id => !level || this.own.get(id).difficulty === level);
      if (index < 0) return {ok: false, reason: this.state.remainingOwn.length ? 'level_finished' : 'round_finished'};
      const ownTemplate = this.own.get(this.state.remainingOwn[index]);
      let foreignTemplate = null;
      const useForeign = this.state.remainingForeign.length && (options.foreign === undefined ? this.rng() < .3 : options.foreign);
      let foreignIndex = -1;
      if (useForeign) {
        foreignIndex = this.state.remainingForeign.findIndex(id => this.foreign.get(id).paired_own_variant_id === ownTemplate.id);
        if (foreignIndex < 0) {
          const ownIds = new Set(ownTemplate.items.map(i => i.product_id));
          let best = -1;
          this.state.remainingForeign.forEach((id, candidateIndex) => {
            const b = this.foreign.get(id);
            const similarity = b.items.filter(i => ownIds.has(i.product_id)).length * 10 - Math.abs(b.items.length - ownTemplate.items.length);
            if (similarity > best) { best = similarity; foreignIndex = candidateIndex; }
          });
        }
        foreignTemplate = this.foreign.get(this.state.remainingForeign[foreignIndex]);
      }
      const allIds = [...new Set([ownTemplate, foreignTemplate].filter(Boolean).flatMap(b => b.items.map(i => i.product_id)))];
      let prices, events;
      for (let attempt = 0; attempt < 2000; attempt++) {
        prices = {};
        allIds.forEach(id => {
          const range = this.products.get(id).training_price_range;
          const count = Math.floor((range.max - range.min) / range.step) + 1;
          const previous = this.state.lastPrices[id];
          const excluded = Number.isInteger(previous) && previous >= range.min && previous <= range.max && (previous - range.min) % range.step === 0;
          let choice = Math.floor(this.rng() * (count - (excluded ? 1 : 0)));
          if (excluded && choice >= (previous - range.min) / range.step) choice++;
          prices[id] = range.min + choice * range.step;
        });
        events = [foreignTemplate, ownTemplate].filter(Boolean).map(template => {
          const items = template.items.map(i => ({...i, unit_price: prices[i.product_id], line_total: prices[i.product_id] * i.quantity}));
          return {id: template.id, owner: template.owner, items, total: items.reduce((sum, i) => sum + i.line_total, 0), heard: false, replays: 0, attempts: [], resolved: false};
        });
        if (events[0].total !== this.state.lastTotal && (events.length === 1 || events[0].total !== events[1].total)) break;
        events = null;
      }
      if (!events) throw new Error('Unable to create different prices');
      const choiceIds = shuffle(allIds, this.rng);
      const targetOptions = Math.min(24,Math.max(6,allIds.length+3));
      for (const p of shuffle(this.content.products, this.rng)) {
        if (choiceIds.length >= targetOptions) break;
        if (!choiceIds.includes(p.id)) choiceIds.push(p.id);
      }
      this.state.remainingOwn.splice(index, 1);
      if (foreignTemplate) this.state.remainingForeign.splice(foreignIndex, 1);
      Object.assign(this.state.lastPrices, prices);
      this.state.active = {
        id: 'visit-' + this.state.cycle + '-' + ownTemplate.id,
        ownVariantId: ownTemplate.id, level: ownTemplate.difficulty,
        basket: copy(ownTemplate.items), prices, events, eventIndex: 0,
        optionIds: shuffle(choiceIds, this.rng),
        quantities: events.some(e => e.items.some(i => i.quantity > 1)),
        selection: {}, amount: '', phase: 'basket', basketPeeks: 0
      };
      return {ok: true};
    }
    beginOrder() {
      if (this.active?.phase !== 'basket') return false;
      this.active.phase = 'answering';
      return true;
    }
    markHeard(eventId) {
      if (this.active?.phase !== 'answering' || this.event.id !== eventId) return false;
      if (this.event.heard) this.event.replays++;
      this.event.heard = true;
      return true;
    }
    select(id, qty) {
      if (this.active?.phase !== 'answering' || !this.active.optionIds.includes(id)) return;
      const q = Math.max(0, Math.min(this.active.quantities ? 3 : 1, Number(qty) || 0));
      if (q) this.active.selection[id] = q;
      else delete this.active.selection[id];
    }
    setAmount(raw) { if (this.active?.phase === 'answering') this.active.amount = String(raw); }
    answer(action) {
      const visit = this.active, event = this.event;
      if (!visit || visit.phase !== 'answering') return {ok: false, reason: 'wrong_phase'};
      if (!event.heard) return {ok: false, reason: 'listen_first'};
      if (action !== 'pay' && action !== 'reject') return {ok: false, reason: 'invalid_action'};
      const selected = Object.entries(visit.selection).map(([product_id, quantity]) => ({product_id, quantity}));
      const amount = parseAmount(visit.amount);
      if (action === 'pay' && (!selected.length || !String(visit.amount).trim())) return {ok: false, reason: 'incomplete'};
      const correct = action === 'reject' ? event.owner !== 'player' : event.owner === 'player' && signature(selected) === signature(event.items) && amount === event.total;
      event.attempts.push({action, selected: copy(selected), rawAmount: visit.amount, correct});
      if (!correct) return {ok: false, reason: 'incorrect', mistake: action === 'reject' ? 'rejected_own' : event.owner !== 'player' ? 'paid_foreign' : 'order_mismatch'};
      event.resolved = true;
      if (action === 'reject') {
        visit.phase = 'foreign_ack';
        this.state.stats.foreignRecognized++;
        if (event.attempts.some(a => !a.correct)) this.state.stats.foreignMistakes++;
      } else visit.phase = 'paid';
      return {ok: true, action};
    }
    continueAfterForeign() {
      if (this.active?.phase !== 'foreign_ack') return false;
      this.active.eventIndex++;
      this.active.selection = {};
      this.active.amount = '';
      this.active.phase = 'answering';
      return true;
    }
    collect() {
      const visit = this.active;
      if (!visit || visit.phase !== 'paid') return false;
      visit.phase = 'collected';
      const hadErrors = visit.events.some(e => e.attempts.some(a => !a.correct));
      this.state.stats.collected++;
      this.state.stats[hadErrors ? 'withErrors' : 'clean']++;
      this.state.lastTotal = this.event.total;
      this.state.history.push({id: visit.id, basket: copy(visit.basket), events: copy(visit.events), hadErrors, level: visit.level});
      return true;
    }
    newRound() {
      if (this.remaining() || (this.active && this.active.phase !== 'collected')) return false;
      this.state.remainingOwn = shuffle([...this.own.keys()], this.rng);
      if (!this.state.remainingForeign.length) this.state.remainingForeign = shuffle([...this.foreign.keys()], this.rng);
      this.state.cycle++;
      this.state.active = null;
      return true;
    }
    speechKeys(event = this.event) {
      return ['welcome', ...event.items.map(i => 'products/' + i.product_id + '-' + i.quantity), 'total', ...amountKeys(event.total)];
    }
    transcript(event = this.event) {
      return event.items.map(i => {
        const product = this.products.get(i.product_id);
        return ONES[i.quantity] + ' ' + product.spoken_unit;
      }).join(', ') + '. ' + amountSentence(event.total);
    }
  }
  root.ShopGame = {Game, signature, parseAmount, numberWords, amountWords, amountSentence, amountKeys, shuffle};
})(globalThis);
