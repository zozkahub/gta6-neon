(() => {
  const glow = document.querySelector('.cursor-glow');
  const dot = document.querySelector('.cursor-dot');
  if (!glow || !dot || !window.matchMedia('(pointer:fine)').matches) return;

  const move = (e) => {
    const x = e.clientX;
    const y = e.clientY;

    dot.style.setProperty('left', `${x}px`, 'important');
    dot.style.setProperty('top', `${y}px`, 'important');
    dot.style.setProperty('transform', 'translate3d(-50%, -50%, 0)', 'important');
    dot.style.setProperty('opacity', '1', 'important');

    glow.style.setProperty('left', `${x}px`, 'important');
    glow.style.setProperty('top', `${y}px`, 'important');
    glow.style.setProperty('transform', 'translate3d(-50%, -50%, 0)', 'important');
    glow.style.setProperty('opacity', '1', 'important');
  };

  document.documentElement.style.setProperty('cursor', 'none', 'important');
  document.body.style.setProperty('cursor', 'none', 'important');
  window.addEventListener('pointermove', move, { passive: true });
  if ('onpointerrawupdate' in window) {
    window.addEventListener('pointerrawupdate', move, { passive: true });
  }
})();
