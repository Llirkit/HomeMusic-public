const form = document.querySelector('form');
const input = document.querySelector('#url');
const button = document.querySelector('button');
const error = document.querySelector('#error');
const status = document.querySelector('#status');

window.HomeMusicSetup.getConfig().then((config) => {
  input.value = config.url;
  error.textContent = config.error;
  input.setAttribute('aria-invalid', config.error ? 'true' : 'false');
  if (config.autoConnect && config.url) form.requestSubmit();
}).catch(() => { error.textContent = 'Не удалось прочитать настройки. Перезапустите приложение.'; });

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (button.disabled) return;
  button.disabled = true;
  input.disabled = true;
  error.textContent = '';
  input.setAttribute('aria-invalid', 'false');
  status.textContent = 'Подключаемся к Хабу…';
  button.textContent = 'Подключение…';
  try {
    const result = await window.HomeMusicSetup.connect(input.value.trim());
    if (result.error) error.textContent = result.error;
  } catch { error.textContent = 'Не удалось подключиться. Попробуйте ещё раз.'; }
  finally {
    button.disabled = false;
    input.disabled = false;
    button.textContent = 'Подключиться';
    status.textContent = '';
    if (error.textContent) {
      input.setAttribute('aria-invalid', 'true');
      input.focus();
    }
  }
});

input.addEventListener('input', () => {
  input.setAttribute('aria-invalid', 'false');
  error.textContent = '';
});
