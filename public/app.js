(() => {
  const state={items:[...window.MEDIA_LIBRARY],query:'',thumbs:new Map()};
  const $=s=>document.querySelector(s);
  const grid=$('#grid'), empty=$('#empty'), count=$('#count'), heroCount=$('#heroCount');
  const player=$('#player'), playerVideo=$('#playerVideo'), playerTitle=$('#playerTitle'), playerMeta=$('#playerMeta'), playerTime=$('#playerTime'), playerDownload=$('#playerDownload');
  const searchModal=$('#searchModal'), searchInput=$('#searchInput'), searchModalInput=$('#searchModalInput');
  const theme=$('#themeAudio'), musicMain=$('#musicMain'), musicButton=$('#musicButton'), musicTime=$('#musicTime');
  const esc=s=>String(s??'').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
  const time=s=>{const n=Math.max(0,Math.round(Number(s)||0));return `${String(Math.floor(n/60)).padStart(2,'0')}:${String(n%60).padStart(2,'0')}`};
  const filtered=()=>{const q=state.query.trim().toLowerCase();return state.items.filter(v=>!q||[v.title,v.category,v.subtitle,v.description].join(' ').toLowerCase().includes(q))};
  function makeFirstSecondThumb(v,img){
    if(state.thumbs.has(v.id)) return;
    state.thumbs.set(v.id,'pending');
    if(v.poster) img.src=v.poster;
    const probe=document.createElement('video');
    probe.crossOrigin='anonymous'; probe.muted=true; probe.playsInline=true; probe.preload='auto'; probe.src=v.videoUrl;
    let settled=false;
    const done=ok=>{ if(settled)return; settled=true; try{probe.pause();probe.removeAttribute('src');probe.load();}catch{} if(!ok) state.thumbs.delete(v.id); };
    const capture=()=>{ try{
      const w=probe.videoWidth||1280,h=probe.videoHeight||720,scale=Math.min(1,1280/w);
      const c=document.createElement('canvas');c.width=Math.max(2,Math.round(w*scale));c.height=Math.max(2,Math.round(h*scale));
      c.getContext('2d').drawImage(probe,0,0,c.width,c.height); const url=c.toDataURL('image/jpeg',.9);
      state.thumbs.set(v.id,url);img.src=url;img.dataset.exact='1.000s';done(true);
    }catch{done(false)} };
    const target = Number.isFinite(probe.duration) && probe.duration > 1 ? 1 : Math.max(0.05, (probe.duration || 0.5) - 0.05);
    const seekToTarget=()=>{try{probe.currentTime=target}catch{}};
    probe.addEventListener('loadedmetadata',seekToTarget,{once:true});
    probe.addEventListener('loadeddata',seekToTarget,{once:true});
    probe.addEventListener('seeked',()=>setTimeout(capture,35),{once:true});
    probe.addEventListener('error',()=>done(false),{once:true});
    probe.load();
    setTimeout(()=>done(false),15000);
  }
  function attachCardFX(card,v){
    card.addEventListener('pointermove',e=>{const r=card.getBoundingClientRect(),x=(e.clientX-r.left)/r.width,y=(e.clientY-r.top)/r.height;card.style.setProperty('--rx',`${((.5-y)*4.5).toFixed(2)}deg`);card.style.setProperty('--ry',`${((x-.5)*5).toFixed(2)}deg`);card.style.setProperty('--gx',`${(x*100).toFixed(0)}%`);card.style.setProperty('--gy',`${(y*100).toFixed(0)}%`)});
    card.addEventListener('pointerleave',()=>{card.style.setProperty('--rx','0deg');card.style.setProperty('--ry','0deg')});
    card.addEventListener('click',e=>{if(!e.target.closest('a'))openPlayer(v)});
    const vid=card.querySelector('.card-video');
    if(vid){card.addEventListener('mouseenter',()=>{vid.currentTime=.05;card.classList.add('playing');vid.play().catch(()=>{})});card.addEventListener('mouseleave',()=>{vid.pause();try{vid.currentTime=.05}catch{}card.classList.remove('playing')})}
  }
  function render(){
    const items=filtered(); count.textContent=String(items.length).padStart(2,'0'); heroCount.textContent=String(state.items.length).padStart(2,'0'); empty.classList.toggle('hidden',items.length!==0);
    grid.innerHTML=items.map((v,i)=>`<article class="media-card" data-id="${esc(v.id)}" style="--i:${i}"><div class="card-media"><img class="poster" src="${esc(v.poster||'./assets/hero.jpg')}" alt="" loading="lazy"><span class="scan"></span><video class="card-video" muted playsinline loop preload="metadata" crossorigin="anonymous" src="${esc(v.videoUrl)}"></video><div class="media-top"><span class="tag">${esc(v.category)}</span><span class="tag">${esc(v.quality)}</span></div><button class="play" aria-label="Play ${esc(v.title)}">▶</button><div class="media-bottom"><span>FRAME · 01.0S</span><span class="duration" data-duration="${esc(v.id)}">--:--</span></div></div><div class="card-info"><div class="small-row"><span>${esc(v.subtitle)}</span><span>${esc(v.source||'DIRECT')}</span></div><h3>${esc(v.title)}</h3><p>${esc(v.description)}</p><div class="card-actions"><button class="play-inline">PLAY</button><a href="${esc(v.downloadUrl||v.videoUrl)}" download>DOWNLOAD ↗</a></div></div></article>`).join('');
    [...grid.querySelectorAll('.media-card')].forEach(card=>{const v=state.items.find(x=>x.id===card.dataset.id);makeFirstSecondThumb(v,card.querySelector('.poster'));attachCardFX(card,v);const duration=card.querySelector('.duration');const temp=card.querySelector('.card-video');temp.addEventListener('loadedmetadata',()=>duration.textContent=time(temp.duration));card.querySelector('.play').onclick=e=>{e.stopPropagation();openPlayer(v)};card.querySelector('.play-inline').onclick=e=>{e.stopPropagation();openPlayer(v)};});
  }
  function openPlayer(v){player.classList.add('open');player.setAttribute('aria-hidden','false');playerTitle.textContent=v.title;playerMeta.textContent=`${v.category} // ${v.quality} // DIRECT`;playerDownload.href=v.downloadUrl||v.videoUrl;playerVideo.src=v.videoUrl;playerVideo.poster=state.thumbs.get(v.id)&&state.thumbs.get(v.id)!=='pending'?state.thumbs.get(v.id):(v.poster||'');playerVideo.load();playerVideo.play().catch(()=>{});}
  function closePlayer(){player.classList.remove('open');player.setAttribute('aria-hidden','true');playerVideo.pause();playerVideo.removeAttribute('src');playerVideo.load()}
  function syncSearch(value){state.query=value;searchInput.value=value;searchModalInput.value=value;render()}
  $('#playerClose').onclick=closePlayer;$('.player-backdrop').onclick=closePlayer;const openPrivate=()=>{location.href='/_c9'};
  const privateShortcut=e=>{const nine=['Digit9','Numpad9'].includes(e.code)||e.key==='9'||e.key===')'; if(e.ctrlKey&&e.shiftKey&&nine){e.preventDefault();e.stopImmediatePropagation();openPrivate();}};
  window.addEventListener('keydown',e=>{if(e.key==='Escape'){closePlayer();searchModal.classList.remove('open');} privateShortcut(e)},true);
  window.addEventListener('keyup',privateShortcut,true);
  searchInput.addEventListener('input',e=>syncSearch(e.target.value));searchModalInput.addEventListener('input',e=>syncSearch(e.target.value));
  $('#searchButton').onclick=()=>{searchModal.classList.add('open');searchModal.setAttribute('aria-hidden','false');searchModalInput.focus();searchModalInput.value=state.query};$('#searchClose').onclick=()=>searchModal.classList.remove('open');
  function setMusic(){const on=!theme.paused;document.body.classList.toggle('music-on',on);musicMain.textContent=on?'Ⅱ':'▶';musicButton.textContent=on?'Ⅱ':'♫'}
  async function toggleMusic(){try{if(theme.paused)await theme.play();else theme.pause();setMusic()}catch{setMusic()}}
  musicButton.onclick=toggleMusic;musicMain.onclick=toggleMusic;$('#heroMusic').onclick=toggleMusic;theme.addEventListener('timeupdate',()=>musicTime.textContent=time(theme.currentTime));
  // Subtle cursor light + parallax; disabled on touch/coarse pointers.
  if(matchMedia('(pointer:fine)').matches){const glow=$('.cursor-glow'),dot=$('.cursor-dot');let tx=0,ty=0,x=0,y=0;window.addEventListener('pointermove',e=>{tx=e.clientX;ty=e.clientY;dot.style.transform=`translate3d(${tx}px,${ty}px,0)`;document.documentElement.style.setProperty('--mx',`${(tx/innerWidth-.5)*2}`);document.documentElement.style.setProperty('--my',`${(ty/innerHeight-.5)*2}`)});const tick=()=>{x+=(tx-x)*.13;y+=(ty-y)*.13;glow.style.transform=`translate3d(${x}px,${y}px,0)`;requestAnimationFrame(tick)};tick();}
  async function boot(){
    try{const r=await fetch('/api/videos',{cache:'no-store'}); if(!r.ok) throw new Error('api'); const data=await r.json(); if(Array.isArray(data)&&data.length){state.items=data;} }catch{} render();
  }
  boot();
})();
