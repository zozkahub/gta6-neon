(() => {
  const id = decodeURIComponent(location.pathname.split('/').pop() || '');
  const root = document.querySelector('#content');
  const esc = s => String(s ?? '').replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
  async function boot(){
    try{
      const r = await fetch('/api/videos/' + encodeURIComponent(id), {cache:'no-store'});
      if(!r.ok) throw new Error('NOT FOUND');
      const v = await r.json();
      document.title = v.title + ' · Grand Theft Auto VI';
      root.innerHTML = `<div class="media-head"><div><div class="eyebrow"><span class="line"></span>${esc(v.category)} · ${esc(v.quality)}</div><h1>${esc(v.title)}</h1><div style="margin-top:10px;color:#8f8999;font:600 9px 'DM Mono'">${esc(v.subtitle)} · ${esc(v.source || 'DIRECT')} · ${esc(v.size || '')}</div></div><div class="media-actions"><a class="back" href="/">← LIBRARY</a><a class="back" href="${esc(v.downloadUrl)}" download>DOWNLOAD ↗</a></div></div><div class="media-stage"><video id="media" controls playsinline preload="metadata" poster="${esc(v.poster)}"></video></div><div class="media-foot"><span>${esc(v.description)}</span><span>STREAM · RANGE ENABLED</span></div>`;
      const video = document.querySelector('#media'); video.src=v.videoUrl; video.load();
    }catch(e){ root.innerHTML=`<div class="error">${esc(e.message || 'MEDIA UNAVAILABLE')}<div style="margin-top:14px"><a class="back" href="/">← BACK TO LIBRARY</a></div></div>`; }
  }
  if(window.matchMedia('(pointer:fine)').matches){const rootEl=document.documentElement,glow=document.querySelector('.cursor-glow'),dot=document.querySelector('.cursor-dot');const move=e=>{const x=Math.round(e.clientX),y=Math.round(e.clientY);rootEl.style.setProperty('--cursor-x',`${x}px`);rootEl.style.setProperty('--cursor-y',`${y}px`);glow.classList.add('cursor-visible');dot.classList.add('cursor-visible')};window.addEventListener('pointermove',move,{passive:true});window.addEventListener('pointerleave',()=>{glow.classList.remove('cursor-visible');dot.classList.remove('cursor-visible')},{passive:true});}
  boot();
})();
