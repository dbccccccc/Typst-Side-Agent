/** The About dialog: version from the manifest, store link, focus management. */
export function createAboutDialog({ storeUrl, onBeforeOpen = () => {}, documentRef = globalThis.document }) {
  const get = id => documentRef.getElementById(id);
  let trigger = null;

  function configure(version) {
    const versionLabel = `Version ${version}`;
    get('about-settings-version').textContent = versionLabel;
    get('about-dialog-version').textContent = versionLabel;
    get('about-chrome-store-link').href = storeUrl;
  }

  function isOpen() {
    return !get('about-dialog-layer').classList.contains('hidden');
  }

  function open(source) {
    onBeforeOpen();
    trigger = source instanceof documentRef.defaultView.HTMLElement ? source : documentRef.activeElement;
    get('about-dialog-layer').classList.remove('hidden');
    get('about-dialog-close').focus();
  }

  function close({ restoreFocus = true } = {}) {
    const layer = get('about-dialog-layer');
    if (layer.classList.contains('hidden')) return false;
    layer.classList.add('hidden');
    const previous = trigger;
    trigger = null;
    if (restoreFocus && previous?.isConnected) previous.focus();
    return true;
  }

  function wire() {
    get('about-icon-button').addEventListener('click', event => open(event.currentTarget));
    get('about-settings-button').addEventListener('click', event => open(event.currentTarget));
    get('about-dialog-close').addEventListener('click', () => close());
    get('about-dialog-layer').addEventListener('click', event => {
      if (event.target === event.currentTarget) close();
    });
  }

  return Object.freeze({ configure, open, close, isOpen, wire });
}
