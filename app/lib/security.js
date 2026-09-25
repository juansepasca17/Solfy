'use strict';
// Endurecimiento de Electron: sin red, sin navegación, solo micrófono para la propia app.

const { app, session } = require('electron');

const APP_ORIGIN = 'app://solfy';

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "media-src 'self'",
  "connect-src 'self'",
  "worker-src 'self'",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

function isAppUrl(url) {
  try {
    return new URL(url).origin === APP_ORIGIN || url.startsWith(APP_ORIGIN + '/');
  } catch {
    return false;
  }
}

function hardenSession(ses = session.defaultSession) {
  // 1) Cualquier petición de red sale cancelada. La app es 100 % local.
  const blocked = { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*', 'ftp://*/*'] };
  ses.webRequest.onBeforeRequest(blocked, (details, cb) => {
    console.warn('[solfy] petición de red bloqueada:', details.url);
    cb({ cancel: true });
  });

  // 2) Permisos: solo audio del micrófono, solo para nuestra página.
  ses.setPermissionRequestHandler((wc, permission, cb, details) => {
    const audioOnly = permission === 'media' && Array.isArray(details.mediaTypes) && details.mediaTypes.length > 0 && details.mediaTypes.every((t) => t === 'audio');
    cb(audioOnly && isAppUrl(details.requestingUrl || wc.getURL()));
  });
  ses.setPermissionCheckHandler((wc, permission, origin, details) => {
    if (permission !== 'media') return false;
    if (details && details.mediaType && details.mediaType !== 'audio') return false;
    return isAppUrl(origin || (wc && wc.getURL()) || '');
  });
  ses.setDevicePermissionHandler(() => false);
  ses.setSpellCheckerEnabled(false);
  ses.on('will-download', (e) => e.preventDefault());
}

function hardenContents(contents) {
  contents.on('will-navigate', (e, url) => {
    if (!isAppUrl(url)) e.preventDefault();
  });
  contents.on('will-redirect', (e, url) => {
    if (!isAppUrl(url)) e.preventDefault();
  });
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-attach-webview', (e) => e.preventDefault());
}

function install() {
  app.on('web-contents-created', (_e, contents) => hardenContents(contents));
}

module.exports = { APP_ORIGIN, CSP, install, hardenSession, isAppUrl };
