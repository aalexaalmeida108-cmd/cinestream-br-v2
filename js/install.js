// Install CineStream as an app on the TV.
//
// Chromium based TV browsers fire `beforeinstallprompt` when the site is
// installable; Samsung's own browser usually does not, so the button falls
// back to a short manual recipe instead of disappearing.

'use strict';

const INSTALL_KEY = 'cinestream:install-dismissed';

let deferredPrompt = null;

function hasDismissed() {
  try {
    return window.localStorage.getItem(INSTALL_KEY) === '1';
  } catch (err) {
    return false;
  }
}

function rememberDismissed() {
  try {
    window.localStorage.setItem(INSTALL_KEY, '1');
  } catch (err) {
    /* private mode: the button will simply come back */
  }
}

// The steps differ a little between the Samsung TV browser and the generic
// Chromium one, so both are listed.
const RECIPE = [
  ['TV antiga (Philco, LG, 2014-2017)', 'Abra o endereço /tv.html no navegador da TV e fixe a página como inicial. Essa versão roda em navegadores de 2015.'],
  ['Samsung TV', 'Menu → Aplicativos → Adicionar → Aplicativo Web. Cole o endereço do CineStream e confirme.'],
  ['Navegador da TV (Chromium)', 'Abra o site, toque no menu do navegador e escolha “Instalar aplicativo” ou “Adicionar à tela de início”.'],
  ['Celular e tablet', 'Chrome: menu → “Instalar aplicativo”. Safari (iPhone): Compartilhar → “Adicionar à Tela de Início”.']
];

function buildDialog() {
  const dialog = document.createElement('div');
  dialog.className = 'install-dialog';
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-label', 'Instalar o CineStream na TV');

  const card = document.createElement('div');
  card.className = 'install-card';

  const title = document.createElement('h2');
  title.textContent = 'Instalar o CineStream na TV';
  card.appendChild(title);

  const lead = document.createElement('p');
  lead.textContent = 'O app abre direto na tela inicial, sem barra de navegador.';
  card.appendChild(lead);

  RECIPE.forEach(([label, text]) => {
    const row = document.createElement('div');
    row.className = 'install-row';
    const name = document.createElement('strong');
    name.textContent = label;
    const body = document.createElement('p');
    body.textContent = text;
    row.append(name, body);
    card.appendChild(row);
  });

  const actions = document.createElement('div');
  actions.className = 'install-actions';

  // When the browser can install on its own, offer that first; the manual
  // recipe stays on the card for the browsers that cannot.
  if (deferredPrompt) {
    const install = document.createElement('button');
    install.type = 'button';
    install.className = 'btn';
    install.textContent = 'Instalar agora';
    install.addEventListener('click', async () => {
      try {
        deferredPrompt.prompt();
        const choice = await deferredPrompt.userChoice;
        if (choice && choice.outcome === 'accepted') {
          dialog.remove();
          rememberDismissed();
          return;
        }
      } catch (error) {
        /* the browser refused the prompt; the recipe below still works */
      }
      deferredPrompt = null;
    });
    actions.appendChild(install);
  }

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'btn btn-ghost';
  close.textContent = 'Entendi';
  close.addEventListener('click', () => {
    dialog.remove();
    rememberDismissed();
  });
  actions.appendChild(close);
  card.appendChild(actions);

  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.remove();
  });

  dialog.appendChild(card);
  document.body.appendChild(dialog);
}

function wireButton(button) {
  if (!button) return;
  if (hasDismissed()) {
    button.hidden = true;
    return;
  }

  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    deferredPrompt = event;
    button.hidden = false;
  });

  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    button.hidden = true;
    rememberDismissed();
  });

  button.addEventListener('click', () => buildDialog());

  // Browsers that never fire the prompt still get the button, so the recipe
  // is one tap away.
  window.setTimeout(() => {
    if (!deferredPrompt && !hasDismissed()) button.hidden = false;
  }, 4000);
}

document.addEventListener('DOMContentLoaded', () => {
  wireButton(document.getElementById('installApp'));
});
