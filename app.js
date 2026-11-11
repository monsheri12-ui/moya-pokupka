(function () {
  'use strict';
  const $ = selector => document.querySelector(selector);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const money = n => new Intl.NumberFormat('ru-RU').format(n);
  const iconPaths = {
    bag:'<path d="M5 8h14l1 13H4L5 8Z"/><path d="M8 8V6a4 4 0 0 1 8 0v2"/>',
    basket:'<path d="m3 9 2 12h14l2-12H3Zm4 0 5-7 5 7M9 13v4m6-4v4"/>',
    play:'<path d="m9 5 10 7-10 7V5Z"/>',
    speaker:'<path d="M11 4 5 9H2v6h3l6 5V4Zm5 4a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14"/>',
    stop:'<rect x="6" y="6" width="12" height="12" rx="2"/>',
    replay:'<path d="M3 10a9 9 0 1 1 2 8M3 3v7h7"/>',
    settings:'<path d="M4 7h16M4 17h16M8 4v6m8 4v6"/>',
    help:'<circle cx="12" cy="12" r="9"/><path d="M9 9a3 3 0 1 1 4 3c-1 .5-1 1-1 2m0 3h.01"/>',
    history:'<path d="M6 3h12v18l-3-2-3 2-3-2-3 2V3Zm3 5h6m-6 4h6m-6 4h3"/>',
    close:'<path d="m6 6 12 12M6 18 18 6"/>',
    fullscreen:'<path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/>',
    check:'<path d="m5 12 4 4L19 6"/>',
    arrow:'<path d="M4 12h16m-6-6 6 6-6 6"/>',
    clock:'<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'
  };
  const icon = name => '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">' + (iconPaths[name] || '') + '</svg>';
  const storageKey = 'moya-pokupka-game-v2-20';
  let storageProblem = false, saved = null;
  try { saved = JSON.parse(localStorage.getItem(storageKey) || 'null'); } catch (_) { storageProblem = true; }
  let game;
  try { game = new ShopGame.Game(GAME_CONTENT, saved); }
  catch (_) { game = new ShopGame.Game(GAME_CONTENT); storageProblem = true; }
  let home = true, message = '', messageKind = '', audioState = 'idle', modalType = '', lastModalFocus = null;
  const levelName = level => ({1:'2–5 товаров',2:'6–10 товаров',3:'11–15 товаров',4:'16–20 товаров',0:'Смешанные корзины'}[level]);
  const save = () => {
    try { localStorage.setItem(storageKey, JSON.stringify(game.snapshot())); }
    catch (_) { storageProblem = true; }
  };
  const announce = text => { $('#announcer').textContent = text; };
  const sprite = (id, sizeClass = '') => {
    const p = game.products.get(id), col = p.sprite_index % 6, row = Math.floor(p.sprite_index / 6);
    return '<span class="sprite '+sizeClass+'" style="background-position:'+col*20+'% '+row*100/3+'%" aria-hidden="true"></span>';
  };

  class AudioPlayer {
    constructor() { this.context = null; this.cache = new Map(); this.byteCache = new Map(); this.token = 0; this.source = null; this.finish = null; }
    stop() {
      this.token++;
      if (this.finish) { this.finish(false); this.finish = null; }
      if (this.source) { try { this.source.stop(); } catch (_) {} this.source = null; }
    }
    async readBytes(path) {
      const url=globalThis.ASSET_MAP?.[path] || path;
      if(this.byteCache.has(url))return this.byteCache.get(url);
      const request=fetch(url).then(response=>{
        if(!response.ok)throw new Error('Audio HTTP '+response.status);
        return response.arrayBuffer();
      });
      this.byteCache.set(url,request);
      while(this.byteCache.size>3)this.byteCache.delete(this.byteCache.keys().next().value);
      try{return await request;}catch(error){this.byteCache.delete(url);throw error;}
    }
    async getBuffer(key) {
      const cacheKey='clip:'+key;
      if(this.cache.has(cacheKey))return this.cache.get(cacheKey);
      const entry=globalThis.AUDIO_OVERRIDES?.clips[key] || AUDIO_MANIFEST.clips[key];
      if(!entry)throw new Error('Missing audio: '+key);
      const request=(async()=>{
        const bytes=await this.readBytes(entry.pack || entry.file);
        let selected;
        if(entry.pack){
          if(!Number.isSafeInteger(entry.offset)||!Number.isSafeInteger(entry.length)||entry.offset<0||entry.length<=0||entry.offset+entry.length>bytes.byteLength)throw new Error('Invalid audio range: '+key);
          selected=bytes.slice(entry.offset,entry.offset+entry.length);
        }else selected=bytes.slice(0);
        return this.context.decodeAudioData(selected);
      })();
      this.remember(cacheKey,request);
      try{return await request;}catch(error){this.cache.delete(cacheKey);throw error;}
    }
    async getSpeechBuffer(key,fallback) {
      return globalThis.AUDIO_OVERRIDES?.clips[key] ? this.getBuffer(key) : this.getStaticBuffer(fallback);
    }
    remember(key,value){
      while(this.cache.size>=8)this.cache.delete(this.cache.keys().next().value);
      this.cache.set(key,value);
      return value;
    }
    async getStaticBuffer(path){
      const key='file:'+path;
      if(this.cache.has(key))return this.cache.get(key);
      const promise=fetch(path).then(r=>{if(!r.ok)throw new Error('Audio HTTP '+r.status);return r.arrayBuffer();}).then(data=>this.context.decodeAudioData(data));
      this.remember(key,promise);
      try{return await promise;}catch(error){this.cache.delete(key);throw error;}
    }
    async play(input, rate = 1, onStart = () => {}) {
      this.stop();
      const token = this.token;
      if (!this.context) {
        const Context = window.AudioContext || window.webkitAudioContext;
        if (!Context) throw new Error('AudioContext is not supported');
        this.context = new Context();
      }
      await this.context.resume();
      const isClipList = Array.isArray(input);
      const buffers = isClipList ? await Promise.all(input.map(k => this.getBuffer(k))) : await Promise.all([this.getSpeechBuffer('orders/'+input.id,'assets/audio/orders/'+input.id+'.mp3'),this.getSpeechBuffer('totals/'+input.total,'assets/audio/totals/'+input.total+'.mp3')]);
      if (token !== this.token) return false;
      const gaps = isClipList ? input.map((key, index) => index === input.length-1 ? 0 : .1) : [.12,0];
      const totalLength = buffers.reduce((n,b,i) => n + b.length + Math.round(gaps[i]*this.context.sampleRate),0);
      const merged = this.context.createBuffer(1,totalLength,this.context.sampleRate);
      const output = merged.getChannelData(0);
      let offset = 0;
      buffers.forEach((buffer,index) => {
        output.set(buffer.getChannelData(0),offset);
        offset += buffer.length + Math.round(gaps[index]*this.context.sampleRate);
      });
      return new Promise(resolve => {
        if (token !== this.token) { resolve(false); return; }
        const source = this.context.createBufferSource();
        source.buffer = merged; source.playbackRate.value = rate; source.connect(this.context.destination);
        this.source = source; this.finish = resolve;
        source.onended = () => {
          if (token === this.token) { this.source = null; this.finish = null; resolve(true); }
          else resolve(false);
        };
        source.start(); onStart();
      });
    }
  }
  const audio = new AudioPlayer();
  function stopAudio() { audio.stop(); audioState = 'idle'; document.body.classList.remove('is-speaking'); }

  function levelOptions(selected) {
    return [1,2,3,4,0].map(v => '<option value="'+v+'" '+(selected===v?'selected':'')+'>'+levelName(v)+'</option>').join('');
  }
  function basketCards(items) {
    return '<div class="basket-card">' + items.map(item => {
      const p = game.products.get(item.product_id);
      const plural={упаковка:'упаковки',пачка:'пачки',пакет:'пакета',бутылка:'бутылки',банка:'банки',связка:'связки',кочан:'кочана',плитка:'плитки',буханка:'буханки'};
      const unit=item.quantity===1?p.unit_ru:(plural[p.unit_ru]||p.unit_ru);
      return '<div class="basket-item">'+sprite(p.id)+'<div class="basket-item-text"><b>'+esc(p.label_ru)+'</b><span lang="mn">'+esc(p.label_mn)+'</span><span class="basket-item-quantity">'+item.quantity+' '+esc(unit)+'</span></div></div>';
    }).join('')+'</div>';
  }
  function renderHome() {
    const collected=game.active?.phase==='collected';
    const action=collected?'next':'start';
    const label=collected?'Ещё за покупками':game.active?'Продолжить покупку':'В магазин';
    return '<section class="menu-board game-board start-menu"><div class="board-pin"></div><p class="menu-eyebrow">Монгольский на слух</p><h1 lang="mn">Миний<br>худалдан авалт</h1><div class="menu-divider" aria-hidden="true"><i></i></div><p class="lead">Загляни в корзину, послушай продавца<br>и забери свои покупки.</p><aside class="audio-notice" aria-labelledby="audio-notice-title">'+icon('speaker')+'<div><h2 id="audio-notice-title">Об озвучке</h2><p>Озвучка сгенерирована и передаёт произношение лишь приблизительно. Пожалуйста, уточняйте точное произношение у носителя монгольского языка.</p></div></aside><button class="primary full-width menu-play" data-action="'+action+'">'+icon('play')+label+'</button><div class="menu-options"><button class="secondary" data-action="settings">'+icon('settings')+' Настройки</button><button class="secondary" data-action="help">'+icon('help')+' Как играть</button></div><button class="quiet-button menu-history" data-action="history">'+icon('history')+' Покупки и ошибки</button>'+(game.active?'<p class="menu-saved">Твоя покупка сохранена</p>':'')+'</section>';
  }

  function renderBasket() {
    return '<section class="basket-preview game-board"><div class="board-pin"></div><h2>Твои покупки</h2><p class="screen-description">Запомни, что лежит в корзине.</p>'+basketCards(game.active.basket)+'<button class="primary full-width" data-action="begin">К кассе '+icon('arrow')+'</button></section>';
  }

  function renderProduct(id) {
    const p = game.products.get(id), qty = game.active.selection[id] || 0;
    return '<div class="product-tile '+(qty?'selected':'')+'" data-product="'+id+'"><button type="button" class="product-toggle" data-action="toggle" data-id="'+id+'" data-focus="product-'+id+'" aria-label="'+esc(p.label_ru)+'" aria-pressed="'+Boolean(qty)+'"><span class="tick" aria-hidden="true">✓</span>'+sprite(id)+'<span class="product-name" lang="mn">'+esc(p.label_mn)+'</span></button>'+(game.active.quantities ? (qty?'<div class="quantity-control"><button type="button" data-action="less" data-id="'+id+'" data-focus="less-'+id+'" aria-label="Уменьшить количество: '+esc(p.label_ru)+'">−</button><span aria-label="Количество">'+qty+'</span><button type="button" data-action="more" data-id="'+id+'" data-focus="more-'+id+'" aria-label="Увеличить количество: '+esc(p.label_ru)+'" '+(qty>=3?'disabled':'')+'>+</button></div>':'<div class="quantity-placeholder"></div>'):'')+'</div>';
  }
  function renderOrder() {
    const e=game.event,busy=audioState!=='idle';
    const columns=game.active.optionIds.length>18?6:game.active.optionIds.length>10?5:4;
    const wave='<span class="waveform" aria-hidden="true">'+Array.from({length:21},()=>'<i></i>').join('')+'</span>';
    return '<form id="answer-form"><section class="npc-speech '+(audioState==='playing'?'playing':'')+'"><h2>Слушай продавца</h2><button type="button" id="play-button" data-action="play" data-focus="play" class="listen-button" aria-label="'+(busy?'Остановить озвучку':'Слушать заказ по-монгольски')+'">'+(audioState==='loading'?'<span class="loading-spinner" aria-hidden="true"></span>':icon(busy?'stop':'play'))+'<span>'+(audioState==='loading'?'Готовлю голос…':busy?'Остановить':'Слушать')+'</span></button>'+wave+'<div class="speech-help-actions"><button type="button" class="replay-button" data-action="replay" '+(busy?'disabled':'')+'>'+icon('replay')+' Ещё раз</button>'+(game.state.settings.hints?'<button type="button" class="hint-button" data-action="hint" '+(!e.heard||busy?'disabled':'')+'>'+icon('help')+' Подсказка</button>':'')+'</div><div id="feedback" class="feedback '+messageKind+'" role="status">'+esc(message || (e.heard?'Теперь твой ответ.':'Послушай заказ целиком.'))+'</div></section><section class="goods-tray" aria-labelledby="goods-title"><h2 id="goods-title">Что назвал продавец?</h2><div class="products-grid '+(game.active.optionIds.length>6?'many':'')+' '+(game.state.settings.labels?'with-labels':'')+'" style="--goods-columns:'+columns+'">'+game.active.optionIds.map(renderProduct).join('')+'</div></section><div class="counter-controls"><button type="button" class="basket-crate" data-action="peek">'+icon('basket')+'<span>Моя корзина<small>Вспомнить покупки</small></span></button><button type="button" class="answer-bubble" data-action="reject" '+(!e.heard||busy?'disabled':'')+'>Это не моя покупка</button><div class="cash-terminal"><div class="terminal-screen"><label for="amount">Сумма к оплате</label><div class="terminal-input"><input id="amount" name="amount" type="text" inputmode="numeric" autocomplete="off" maxlength="12" aria-describedby="feedback" value="'+esc(game.active.amount)+'"><span aria-hidden="true">₮</span></div></div><button type="submit" class="terminal-pay" '+(!e.heard||busy?'disabled':'')+'>'+icon('check')+'<span>Оплатить</span></button></div></div></form>';
  }

  function renderForeignAck() {
    return '<section class="game-board result-board"><div class="result-emblem">'+icon('check')+'</div><h2>Чужая покупка!</h2><p class="lead">Ты верно узнал другой заказ.<br>А теперь продавец обслужит тебя.</p><button class="primary full-width" data-action="continue-foreign">Теперь мой заказ '+icon('speaker')+'</button></section>';
  }

  function receipt(event) {
    return '<div class="receipt">'+event.items.map(i=>'<div class="receipt-row"><span>'+esc(game.products.get(i.product_id).label_ru)+' × '+i.quantity+'</span><span>'+money(i.line_total)+' ₮</span></div>').join('')+'<div class="receipt-total"><span>Оплачено</span><strong>'+money(event.total)+' ₮</strong></div></div>';
  }
  function renderPaid() {
    return '<section class="game-board result-board"><div class="result-emblem">'+icon('check')+'</div><h2>Оплачено!</h2><p class="screen-description">Все товары и сумма совпали.</p>'+receipt(game.event)+'<button class="primary full-width" data-action="collect">'+icon('bag')+' Забрать покупки</button></section>';
  }

  function renderCollected() {
    return '<section class="game-board result-board collected-screen"><div class="reward-bag-scene"><img class="reward-bag-art" src="assets/reward-bag-v2.png" alt="Красивый бумажный пакет с ручками и монгольским орнаментом"><div class="reward-bag-name" lang="mn"><span>Миний</span><strong>худалдан<br>авалт</strong></div></div><h2>Твой пакет!</h2><p class="lead">Покупки у тебя. Можно идти дальше.</p><button class="primary full-width" data-action="next">Ещё за покупками '+icon('arrow')+'</button><button class="quiet-button" data-action="history">'+icon('history')+' Посмотреть ошибки</button></section>';
  }

  function renderRound(levelOnly) {
    return '<section class="game-board result-board"><div class="result-emblem">'+icon('check')+'</div><h2>'+(levelOnly?'Здесь всё куплено':'Магазин закрывает смену')+'</h2><p class="lead">'+(levelOnly?'Выбери другой размер корзины в настройках и продолжай игру.':'Ты встретил все корзины. Можно посмотреть ошибки или начать новый круг с новыми ценами.')+'</p>'+(levelOnly?'<button class="primary full-width" data-action="settings">Открыть настройки '+icon('settings')+'</button><button class="secondary full-width" data-action="next">Продолжить</button>':'<button class="primary full-width" data-action="new-round">Новый круг '+icon('replay')+'</button>')+'<button class="quiet-button" data-action="history">Посмотреть ошибки</button></section>';
  }

  let exhausted = null;
  function render() {
    const focused = document.activeElement;
    const focusId = focused?.id, focusKey = focused?.dataset?.focus;
    const selectionStart = focused?.tagName==='INPUT' ? focused.selectionStart : null;
    const selectionEnd = focused?.tagName==='INPUT' ? focused.selectionEnd : null;
    const visit = game.active;
    const phase=home?'home':exhausted?'round':visit?.phase||'home';
    document.body.dataset.phase=phase;
    $('.shop-scene').setAttribute('aria-label',phase==='home'||phase==='basket'?'Зал магазина со стеллажами продуктов':'Продавец за прилавком уютного магазина в Улан-Баторе');
    $('#game').className='phase-'+phase;
    let html;
    if (home) html = renderHome();
    else if (exhausted) html = renderRound(exhausted==='level_finished');
    else if (!visit) html = renderHome();
    else html = ({basket:renderBasket,answering:renderOrder,foreign_ack:renderForeignAck,paid:renderPaid,collected:renderCollected}[visit.phase] || renderHome)();
    $('#game').innerHTML = (storageProblem?'<p class="storage-notice">Браузер не смог сохранить прогресс. Текущая игра продолжится.</p>':'')+html;
    const completed = 300-game.state.remainingOwn.length-(visit&&visit.phase!=='collected'?1:0);
    const stage = home?'Практика без спешки':exhausted?'Круг покупок':visit?.phase==='basket'?'Выбираем покупки':visit?.phase==='collected'?'Пакет получен':'У кассы';
    const stageIndex = !visit||home?0:({basket:1,answering:2,foreign_ack:2,paid:3,collected:4}[visit.phase]||0);
    $('#progress').innerHTML = '<div class="progress-meta"><span>'+stage+'</span></div><span class="progress-dots" aria-hidden="true">'+[1,2,3,4].map(i=>'<i class="'+(i<=stageIndex?'done':'')+'"></i>').join('')+'</span>';
    if (focusId && $('#'+focusId)) {
      const el = $('#'+focusId); el.focus({preventScroll:true});
      if (selectionStart!==null) try { el.setSelectionRange(selectionStart,selectionEnd); } catch (_) {}
    } else if (focusKey) {
      const el = document.querySelector('[data-focus="'+focusKey+'"]');
      if (el) el.focus({preventScroll:true});
    }
  }
  function focusScreen() {
    $('#game').focus({preventScroll:true});
    if (innerWidth<881) $('.game-shell').scrollIntoView({behavior:'auto',block:'start'});
  }
  function startVisit() {
    stopAudio(); message=''; messageKind=''; home=false;
    try {
      const result = game.startVisit();
      exhausted = result.ok ? null : result.reason;
      save(); render(); focusScreen();
    } catch (_) {
      message='Не удалось подготовить покупку. Обнови страницу и попробуй снова.';
      announce(message); render();
    }
  }
  async function playOrder(forceReplay = false) {
    if (game.active?.phase!=='answering') return;
    if (audioState!=='idle') { stopAudio(); render(); return; }
    const eventId = game.event.id, visitId = game.active.id;
    audioState='loading'; message=''; messageKind=''; render();
    announce('Звучит заказ по-монгольски.');
    try {
      const complete = await audio.play(game.event,game.state.settings.speed,()=>{
        audioState='playing'; document.body.classList.add('is-speaking'); render();
      });
      if (complete && game.active?.id===visitId && game.event?.id===eventId && game.active.phase==='answering') {
        game.markHeard(eventId); save();
        announce('Заказ прозвучал. Можно отметить товары, ввести сумму или выбрать «Это не моя покупка».');
      }
    } catch (_) {
      message='Не получилось загрузить голос. Проверь соединение и нажми «Слушать» ещё раз.'; messageKind='error'; announce(message);
    } finally { audioState='idle'; document.body.classList.remove('is-speaking'); render(); }
  }
  function answer(action) {
    if (audioState!=='idle') return;
    const result = game.answer(action);
    if (result.ok) {
      stopAudio(); message=''; messageKind=''; save(); render(); focusScreen();
      announce(action==='pay'?'Оплата прошла. Можно забрать покупки.':'Верно: это чужая покупка. Дальше твой заказ.');
      if (action==='pay') audio.play(['thanks'],game.state.settings.speed).catch(()=>{});
    } else {
      message = result.mistake==='rejected_own' ? 'Это твоя покупка. Послушай ещё раз и отметь свои товары.' : result.mistake==='paid_foreign' ? 'Сейчас прозвучала чужая покупка. Твой заказ ещё впереди.' : {listen_first:'Сначала послушай заказ целиком.',incomplete:'Отметь товары и введи сумму цифрами.',incorrect:'Пока не совпало. Проверь товары, количество и сумму.'}[result.reason] || 'Попробуй ещё раз.';
      messageKind = result.reason==='incomplete'||result.reason==='listen_first'?'':'error';
      save(); render(); announce(message);
    }
  }

  function openModal(type, content, title) {
    stopAudio(); render(); lastModalFocus = document.activeElement; modalType = type;
    $('#modal-content').innerHTML = '<div class="modal-heading"><h2 id="modal-title">'+title+'</h2><button class="icon-button" data-modal="close" aria-label="Закрыть">'+icon('close')+'</button></div>'+content;
    if (!$('#modal').open) $('#modal').showModal();
  }
  function showHelp() {
    openModal('help','<div class="modal-copy"><ol><li><strong>Посмотри свою корзину.</strong> Запомни товары и количество упаковок.</li><li><strong>Послушай продавца.</strong> Он перечислит товары и сумму по-монгольски. Запись можно повторять. Если не удалось разобрать слова, открой «Подсказку»: там есть текст продавца и перевод. Подсказки можно выключить в настройках.</li><li><strong>Отметь всё услышанное.</strong> На уровне с количеством выбери число упаковок. Введи общую сумму цифрами.</li><li><strong>Оплати и забери пакет.</strong> Покупка завершится только после верного ответа и нажатия «Забрать покупки».</li></ol><div class="hint-box"><strong>Услышал другой набор?</strong><br>Нажми «Это не моя покупка». Твоя корзина сохранится, и продавец перейдёт к твоему заказу.</div><p>Корзины идут без повторов до конца набора. При новой покупке цены меняются, а при повторном прослушивании остаются прежними.</p><p>Прогресс сохраняется в этом браузере. В «Покупках и ошибках» можно снова прослушать завершённые заказы и посмотреть разбор.</p></div>','Как играть');
  }
  function showSettings() {
    const s = game.state.settings;
    openModal('settings','<div class="setting-row"><div><label for="setting-level">Состав корзины</label><small>Применяется к следующей покупке.</small></div><select id="setting-level">'+levelOptions(s.level)+'</select></div><div class="setting-row"><div><label for="setting-speed">Скорость продавца</label><small>Можно слушать немного медленнее.</small></div><select id="setting-speed"><option value="0.85" '+(s.speed===.85?'selected':'')+'>Медленнее</option><option value="1" '+(s.speed===1?'selected':'')+'>Обычная</option><option value="1.1" '+(s.speed===1.1?'selected':'')+'>Быстрее</option></select></div><div class="setting-row"><div><label for="setting-labels">Подписи на монгольском</label><small>Небольшая опора под картинками товаров.</small></div><input id="setting-labels" type="checkbox" '+(s.labels?'checked':'')+'></div><div class="setting-row"><div><label for="setting-hints">Подсказки</label><small>Показывать кнопку с текстом и переводом заказа.</small></div><input id="setting-hints" type="checkbox" '+(s.hints?'checked':'')+'></div><p class="settings-footnote">Все настройки и прогресс сохраняются в этом браузере.</p>','Настройки');
  }
  function showHint() {
    if (!game.state.settings.hints||audioState!=='idle'||!game.markHintUsed()) return;
    save();
    const current=game.event;
    const translation='<ul class="hint-goods">'+current.items.map(item=>'<li><span>'+esc(game.products.get(item.product_id).label_ru)+'</span><strong>× '+item.quantity+'</strong></li>').join('')+'</ul><p class="hint-total">Сумма к оплате: <strong>'+money(current.total)+' ₮</strong></p>';
    openModal('hint','<p class="modal-copy">Не разобрал слова? Прочитай фразу продавца и сравни её со своей корзиной.</p><div class="mn-transcript hint-transcript" lang="mn">'+esc(game.transcript(current))+'</div><details class="hint-translation"><summary>Показать перевод</summary>'+translation+'</details><p class="hint-note">Подсказка относится к тому заказу, который прозвучал сейчас. Он может оказаться чужим.</p><button class="primary full-width" data-modal="close">Вернуться к заказу</button>','Подсказка');
  }
  function showPeek() {
    if (!game.active) return;
    game.active.basketPeeks++; save();
    openModal('peek','<p class="modal-copy">Вот что ты принёс к кассе. Сверяй с тем, что называет продавец.</p>'+basketCards(game.active.basket)+'<button class="primary full-width" data-modal="close">Вернуться к продавцу</button>','Моя корзина');
  }
  function itemNames(items) { return items.map(i=>esc(game.products.get(i.product_id).label_ru)+' × '+i.quantity).join(', '); }
  function reviewEvent(event, basket, historyIndex, eventIndex) {
    const wrong = event.attempts.filter(a=>!a.correct);
    let difference = '';
    if (event.owner!=='player') {
      const heard = new Set(event.items.map(i=>i.product_id));
      const own = new Set(basket.map(i=>i.product_id));
      const missing = basket.filter(i=>!heard.has(i.product_id));
      const extra = event.items.filter(i=>!own.has(i.product_id));
      difference='<p class="review-answer">Верный ответ: «Это не моя покупка».</p><p class="review-basket">'+(missing.length?'В твоей корзине: '+itemNames(missing)+'. ':'')+(extra.length?'В чужом заказе: '+itemNames(extra)+'.':'Состав или количество отличается от твоей корзины.')+'</p>';
    } else difference='<p class="review-answer">Правильная сумма: '+money(event.total)+' ₮.</p>';
    return '<section class="review-event"><h3>'+(event.owner==='player'?'Твоя покупка':'Чужой заказ')+'</h3><p class="review-basket">'+itemNames(event.items)+'</p><div class="mn-transcript" lang="mn">'+esc(game.transcript(event))+'</div>'+(event.hintUsed?'<p class="review-hint">Использована подсказка</p>':'')+'<button class="secondary review-audio" data-modal="review-play" data-history="'+historyIndex+'" data-event="'+eventIndex+'">'+icon('speaker')+' Послушать</button>'+wrong.map((a,i)=>'<div class="attempt-row"><b>Попытка '+(i+1)+':</b> '+(a.action==='reject'?'«Это не моя покупка»':itemNames(a.selected)+'<br>Сумма: '+esc(a.rawAmount||'не указана')+' ₮')+'</div>').join('')+difference+'</section>';
  }
  function historyHtml(onlyErrors=false) {
    const stats = game.state.stats, history = game.state.history;
    const visible = history.map((r,i)=>({r,i})).reverse().filter(({r})=>!onlyErrors||r.hadErrors);
    return '<div class="review-summary"><div><b>'+stats.collected+'</b><span>забрано покупок</span></div><div><b>'+stats.clean+'</b><span>без ошибок</span></div><div><b>'+stats.foreignRecognized+'</b><span>чужих распознано</span></div><div><b>'+stats.withHints+'</b><span>с подсказкой</span></div></div><p class="stats-note">«Без ошибок» — покупки без ошибок и подсказок.</p><label class="review-filter"><input type="checkbox" id="only-errors" '+(onlyErrors?'checked':'')+'> Только покупки с ошибками</label>'+(visible.length?'<div class="history-list">'+visible.map(({r,i})=>'<details class="history-entry"><summary>Покупка №'+(i+1)+'<span class="history-status '+(r.hadErrors?'errors':'')+'">'+(r.hadErrors?'с исправлениями':r.hadHints?'с подсказкой':'без ошибок')+(r.hadErrors&&r.hadHints?' · с подсказкой':'')+'</span></summary><div class="history-detail">'+r.events.map((e,j)=>reviewEvent(e,r.basket,i,j)).join('')+'</div></details>').join('')+'</div>':'<div class="empty-state">'+icon('history')+(onlyErrors?'Здесь нет покупок с ошибками.':'Здесь появятся твои завершённые покупки.')+'</div>');
  }
  function showHistory() { openModal('history',historyHtml(),'Покупки и ошибки'); }
  function closeModal() {
    stopAudio(); $('#modal').close(); modalType=''; render();
    if (lastModalFocus?.isConnected) lastModalFocus.focus({preventScroll:true});
  }

  document.addEventListener('click',event=>{
    const button=event.target.closest('[data-action]');
    if (!button) return;
    const action=button.dataset.action, id=button.dataset.id;
    if (action==='start') { exhausted=null; if (game.active) { home=false;render();focusScreen(); } else startVisit(); }
    if (action==='begin') { game.beginOrder(); save(); render(); focusScreen(); playOrder(); }
    if (action==='play'||action==='replay') playOrder(action==='replay');
    if (action==='toggle'||action==='more'||action==='less') {
      const qty=game.active?.selection[id]||0;
      game.select(id,action==='toggle'?(qty?0:1):action==='more'?qty+1:qty-1);
      message='';messageKind='';save();render();
    }
    if (action==='reject') answer('reject');
    if (action==='peek') showPeek();
    if (action==='hint') showHint();
    if (action==='continue-foreign') { game.continueAfterForeign();save();render();focusScreen();playOrder(); }
    if (action==='collect') { stopAudio();if(game.collect()){save();render();focusScreen();announce('Покупки у тебя.');} }
    if (action==='next') startVisit();
    if (action==='new-round'&&game.newRound()) { exhausted=null;save();startVisit(); }
    if (action==='history') showHistory();
    if (action==='settings') showSettings();
    if (action==='help') showHelp();
    if (action==='boot-retry') loadGameAssets();
  });
  document.addEventListener('submit',event=>{
    if(event.target.id==='answer-form'){event.preventDefault();answer('pay');}
  });
  document.addEventListener('input',event=>{
    if(event.target.id==='amount'){game.setAmount(event.target.value);save();}
  });
  document.addEventListener('change',event=>{
    const id=event.target.id;
    if(id==='home-level'||id==='setting-level'){game.state.settings.level=Number(event.target.value);save();}
    if(id==='setting-speed'){game.state.settings.speed=Number(event.target.value);save();}
    if(id==='setting-labels'){game.state.settings.labels=event.target.checked;save();}
    if(id==='setting-hints'){game.state.settings.hints=event.target.checked;save();}
    if(id==='only-errors'){
      const checked=event.target.checked;
      $('#modal-content').innerHTML='<div class="modal-heading"><h2 id="modal-title">Покупки и ошибки</h2><button class="icon-button" data-modal="close" aria-label="Закрыть">'+icon('close')+'</button></div>'+historyHtml(checked);
      $('#only-errors').focus({preventScroll:true});
    }
  });
  $('#modal').addEventListener('click',async event=>{
    if(event.target===$('#modal')) { const r=$('#modal').getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)closeModal();return; }
    const button=event.target.closest('[data-modal]');if(!button)return;
    if(button.dataset.modal==='close')closeModal();
    if(button.dataset.modal==='review-play'){
      const e=game.state.history[Number(button.dataset.history)]?.events[Number(button.dataset.event)];
      if(!e)return;
      button.disabled=true;
      try{await audio.play(e,game.state.settings.speed);}catch(_){announce('Запись не загрузилась. Попробуй ещё раз.');}
      finally{button.disabled=false;}
    }
  });
  $('#modal').addEventListener('cancel',event=>{event.preventDefault();closeModal();});
  $('#home-link').addEventListener('click',event=>{event.preventDefault();stopAudio();home=true;render();});
  $('#history-button').innerHTML=icon('history');$('#history-button').addEventListener('click',showHistory);
  $('#settings-button').innerHTML=icon('settings');$('#settings-button').addEventListener('click',showSettings);
  $('#help-button').innerHTML=icon('help');$('#help-button').addEventListener('click',showHelp);
  $('#fullscreen-button').innerHTML=icon('fullscreen');
  $('#fullscreen-button').addEventListener('click',async()=>{
    try{if(document.fullscreenElement)await document.exitFullscreen();else await $('.game-shell').requestFullscreen();}catch(_){announce('В этом браузере полноэкранный режим недоступен.');}
  });
  document.addEventListener('visibilitychange',()=>{if(document.hidden){stopAudio();render();}});
  addEventListener('pagehide',()=>{stopAudio();save();});
  save();render();
  window.scrollTo(0,0);
  let bootAttempt=0;
  async function loadGameAssets() {
    const attempt=++bootAttempt, loader=$('#loading-screen');
    loader.hidden=false;loader.classList.remove('is-ready');loader.setAttribute('aria-busy','true');
    $('.game-shell').inert=true;document.body.classList.add('is-loading');
    $('#loading-retry').hidden=true;
    $('#loading-progress').value=0;$('#loading-percent').textContent='0%';
    $('#loading-status').textContent='Открываем магазин…';
    const resources=[['assets/aisles.png','Расставляем товары…'],['assets/shop.png','Открываем кассу…'],['assets/groceries.png','Наполняем полки…'],['assets/reward-bag-v2.png','Готовим пакеты…'],['assets/audio/khulan-v1/manifest.json','Готовим озвучку…']];
    let complete=0;
    const tasks=resources.map(async([src,label])=>{
      const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),20000);
      try {
        const response=await fetch(src,{signal:controller.signal});
        if(!response.ok)throw new Error('Asset HTTP '+response.status);
        if(src.endsWith('/manifest.json')){
          const manifest=await response.json();
          if(manifest.version!=='khulan-v1'||manifest.voice!=='chimege:khulan'||Object.keys(manifest.clips||{}).length!==481)throw new Error('Invalid audio manifest');
          const thanks=manifest.clips.thanks;
          if(!thanks?.pack)throw new Error('Missing thank-you audio');
          const url=globalThis.ASSET_MAP?.[thanks.pack] || thanks.pack;
          const packResponse=await fetch(url,{signal:controller.signal});
          if(!packResponse.ok)throw new Error('Audio HTTP '+packResponse.status);
          const bytes=await packResponse.arrayBuffer();
          if(!Number.isSafeInteger(thanks.offset)||!Number.isSafeInteger(thanks.length)||thanks.offset<0||thanks.length<=0||thanks.offset+thanks.length>bytes.byteLength)throw new Error('Invalid thank-you audio');
          audio.byteCache.set(url,Promise.resolve(bytes));
          globalThis.AUDIO_OVERRIDES=manifest;
        }else{
          const blob=await response.blob();
          if(src.endsWith('.png')){
            const image=new Image(),url=URL.createObjectURL(blob);
            try {image.src=url;await image.decode();}finally{URL.revokeObjectURL(url);}
          }
        }
      } finally {
        clearTimeout(timeout);
        if(attempt===bootAttempt){
          const value=Math.round(++complete/resources.length*100);
          $('#loading-progress').value=value;$('#loading-percent').textContent=value+'%';
          $('#loading-status').textContent=label;
        }
      }
    });
    const results=await Promise.allSettled(tasks);
    if(attempt!==bootAttempt)return;
    loader.setAttribute('aria-busy','false');
    if(results.some(result=>result.status==='rejected')){
      $('#loading-status').textContent='Магазин не загрузился полностью. Проверь соединение и попробуй ещё раз.';
      $('#loading-retry').hidden=false;
      return;
    }
    $('#loading-status').textContent='Добро пожаловать!';
    $('.game-shell').inert=false;document.body.classList.remove('is-loading');
    loader.classList.add('is-ready');
    setTimeout(()=>{if(attempt===bootAttempt)loader.hidden=true;},250);
  }
  loadGameAssets();
})();
