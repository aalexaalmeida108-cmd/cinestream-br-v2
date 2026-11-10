// CineStream donation modal.
// The PIX BR Code is a static EMV payload (key + R$ 20,00 + txid CINESTREAM),
// so it can be embedded here and rendered once as a QR at build time.

'use strict';

(function () {
  // EMV BR Code, CRC16-CCITT (0xFFFF / 0x1021) appended.
  const PIX_KEY = '1088safary@gmail.com';
  const PIX_BRCODE = '00020126420014br.gov.bcb.pix01201088safary@gmail.com520400005303986540520.005802BR5910CINESTREAM6009SAO PAULO62140510CINESTREAM6304BCA9';

  const modal = document.getElementById('pixModal');
  if (!modal) return;

  const openers = [document.getElementById('donateOpen'), document.getElementById('donateOpenFooter')]
    .filter(Boolean);
  const closeBtn = document.getElementById('pixClose');
  const copyKey = document.getElementById('pixCopy');
  const copyBr = document.getElementById('pixBrCode');
  const status = document.getElementById('pixStatus');
  let lastFocus = null;

  function open() {
    lastFocus = document.activeElement;
    modal.hidden = false;
    document.body.classList.add('has-modal');
    if (closeBtn) closeBtn.focus();
  }

  function close() {
    modal.hidden = true;
    document.body.classList.remove('has-modal');
    if (lastFocus && typeof lastFocus.focus === 'function') lastFocus.focus();
  }

  function flash(message) {
    if (!status) return;
    status.textContent = message;
    status.classList.add('is-active');
    window.clearTimeout(flash.timer);
    flash.timer = window.setTimeout(() => {
      status.textContent = 'Chave PIX (e-mail) \u00b7 valor de refer\u00eancia R$ 20,00';
      status.classList.remove('is-active');
    }, 2600);
  }

  async function copy(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (error) {
      const helper = document.createElement('textarea');
      helper.value = text;
      helper.setAttribute('readonly', '');
      helper.style.position = 'fixed';
      helper.style.opacity = '0';
      document.body.appendChild(helper);
      helper.select();
      let ok = false;
      try {
        ok = document.execCommand('copy');
      } catch (copyError) {
        ok = false;
      }
      helper.remove();
      return ok;
    }
  }

  openers.forEach((button) => button.addEventListener('click', open));

  if (closeBtn) closeBtn.addEventListener('click', close);

  modal.addEventListener('click', (event) => {
    if (event.target === modal) close();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !modal.hidden) close();
  });

  if (copyKey) {
    copyKey.addEventListener('click', async () => {
      const ok = await copy(PIX_KEY);
      flash(ok ? 'Chave copiada: ' + PIX_KEY : 'N\u00e3o foi poss\u00edvel copiar. Selecione o texto acima.');
    });
  }

  if (copyBr) {
    copyBr.addEventListener('click', async () => {
      const ok = await copy(PIX_BRCODE);
      flash(ok ? 'C\u00f3digo PIX copiado \u2014 cole no seu banco.' : 'N\u00e3o foi poss\u00edvel copiar o c\u00f3digo.');
    });
  }
})();
