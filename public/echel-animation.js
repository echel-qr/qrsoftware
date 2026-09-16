/* Decorative motion only; no order or printer connection is made by this illustration. */
(() => {
  const studio = document.querySelector('.echel-print-studio');
  const button = studio?.querySelector('.ep-motion-toggle');
  if (!button) return;
  const updateLabel=()=>{
    const paused=studio.classList.contains('ep-paused');
    button.setAttribute('aria-pressed', String(paused));
    const label=window.QSPi18n?.t(paused ? 'Play animation' : 'Pause animation') || (paused ? 'Play animation' : 'Pause animation');
    button.setAttribute('aria-label', label);
    button.title = label;
  };
  button.addEventListener('click',()=>{studio.classList.toggle('ep-paused');updateLabel();});
  window.addEventListener('i18n:changed',updateLabel);
})();
