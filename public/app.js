(() => {
  const state = { page: 0, limit: 12, total: 0, hasMore: true, loading: false, query: '', searchTimer: null };
  const $ = s => document.querySelector(s);
  const grid = $('#grid'), empty = $('#empty'), loading = $('#loading'), loadMore = $('#loadMore');
  const count = $('#count'), heroCount = $('#heroCount');
  const searchInput = $('#searchInput'), searchModal = $('#searchModal'), searchModalInput = $('#searchModalInput');
  const theme = $('#themeAudio'), musicMain = $('#musicMain'), musicButton = $('#musicButton'), musicTime = $('#musicTime');
  const esc = s => String(s ?? '').replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
  const time = s => { const n=Math.max(0,Math.round(Number(s)||0)); return `${String(Math.floor(n/60)).padStart(2,'0')}:${String(n%60).padStart(2,'0')}`; };

  function makeCard(v, i) {
    const wrap = document.createElement('article');
    wrap.className = 'media-card'; wrap.dataset.id = v.id; wrap.style.setProperty('--i', i);
    wrap.innerHTML = `<div class="card-media" role="link" tabindex="0" aria-label="Open ${esc(v.title)}"><img class="poster" src="${esc(v.poster || './assets/hero-side.jpg')}" alt="" loading="lazy" decoding="async"><div class="media-top"><span class="tag">${esc(v.category)}</span><span class="tag">${esc(v.quality)}</span></div><button class="play" type="button" aria-label="Open ${esc(v.title)}">▶</button><div class="media-bottom"><span>OPEN · MEDIA PAGE</span><span>${esc(v.duration ? time(v.duration) : '—')}</span></div></div><div class="card-info"><div class="small-row"><span>${esc(v.subtitle)}</span><span>${esc(v.source || 'DIRECT')}</span></div><h3>${esc(v.title)}</h3><p>${esc(v.description)}</p><div class="card-actions"><button class="play-inline" type="button">OPEN PAGE</button></div></div>`;
    const open = () => { location.href = `/video/${encodeURIComponent(v.id)}`; };
    wrap.querySelector('.card-media').addEventListener('click', open);
    wrap.querySelector('.card-media').addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
    wrap.querySelector('.play').addEventListener('click', e => { e.stopPropagation(); open(); });
    wrap.querySelector('.play-inline').addEventListener('click', e => { e.stopPropagation(); open(); });
    wrap.addEventListener('pointermove', e => { const r=wrap.getBoundingClientRect(),x=(e.clientX-r.left)/r.width,y=(e.clientY-r.top)/r.height; wrap.style.setProperty('--rx',`${((.5-y)*4).toFixed(2)}deg`); wrap.style.setProperty('--ry',`${((x-.5)*4).toFixed(2)}deg`); wrap.style.setProperty('--gx',`${(x*100).toFixed(0)}%`); wrap.style.setProperty('--gy',`${(y*100).toFixed(0)}%`); });
    wrap.addEventListener('pointerleave', () => { wrap.style.setProperty('--rx','0deg'); wrap.style.setProperty('--ry','0deg'); });
    return wrap;
  }

  async function loadPage(reset = false) {
    if (state.loading || (!state.hasMore && !reset)) return;
    if (reset) { state.page=0; state.hasMore=true; grid.innerHTML=''; empty.classList.add('hidden'); }
    state.loading=true; loading.hidden=false; loading.textContent='LOADING MEDIA...';
    try {
      const next = state.page + 1;
      const url = new URL('/api/videos', location.origin); url.searchParams.set('page', next); url.searchParams.set('limit', state.limit); if (state.query) url.searchParams.set('q', state.query);
      const r = await fetch(url, { cache:'no-store' }); if (!r.ok) throw new Error('library');
      const data = await r.json(); state.page=data.page; state.total=data.total; state.hasMore=data.hasMore;
      count.textContent=String(data.total).padStart(2,'0'); heroCount.textContent=String(data.total).padStart(2,'0');
      if (!data.items.length && state.page===1) empty.classList.remove('hidden');
      data.items.forEach((v,idx) => grid.appendChild(makeCard(v, idx)));
      loadMore.hidden = !state.hasMore || !data.items.length; loading.hidden=true;
    } catch { loading.hidden=false; loading.textContent='LIBRARY REQUEST FAILED'; }
    finally { state.loading=false; }
  }

  const applySearch = v => { state.query=v.trim(); searchInput.value=v; searchModalInput.value=v; clearTimeout(state.searchTimer); state.searchTimer=setTimeout(()=>loadPage(true),260); };
  searchInput.addEventListener('input', e => applySearch(e.target.value));
  searchModalInput.addEventListener('input', e => applySearch(e.target.value));
  loadMore.addEventListener('click', () => loadPage(false));
  $('#searchButton').onclick=()=>{ searchModal.classList.add('open'); searchModal.setAttribute('aria-hidden','false'); searchModalInput.focus(); };
  $('#searchClose').onclick=()=>searchModal.classList.remove('open');
  window.addEventListener('keydown',e=>{if(e.key==='Escape')searchModal.classList.remove('open');});

  function setMusic(){const on=!theme.paused;musicMain.textContent=on?'Ⅱ':'▶';musicButton.textContent=on?'Ⅱ':'♫';document.body.classList.toggle('music-on',on);}
  async function toggleMusic(){try{if(theme.paused)await theme.play();else theme.pause();setMusic()}catch{setMusic()}}
  musicButton.onclick=toggleMusic; musicMain.onclick=toggleMusic; $('#heroMusic').onclick=toggleMusic; theme.addEventListener('timeupdate',()=>musicTime.textContent=time(theme.currentTime));

  if(matchMedia('(pointer:fine)').matches){const root=document.documentElement,glow=$('.cursor-glow'),dot=$('.cursor-dot');const move=e=>{const x=Math.round(e.clientX),y=Math.round(e.clientY);root.style.setProperty('--cursor-x',`${x}px`);root.style.setProperty('--cursor-y',`${y}px`);root.style.setProperty('--mx',`${(x/innerWidth-.5)*2}`);root.style.setProperty('--my',`${(y/innerHeight-.5)*2}`);glow.classList.add('cursor-visible');dot.classList.add('cursor-visible')};window.addEventListener('pointermove',move,{passive:true});window.addEventListener('pointerenter',move,{passive:true});window.addEventListener('pointerleave',()=>{glow.classList.remove('cursor-visible');dot.classList.remove('cursor-visible')},{passive:true});}

  loadPage(true);
})();
