const APP_ID = 'ru.llirkit.homemusic.desktop';
const CHANNELS = Object.freeze({ state: 'hm:player-state', command: 'hm:player-command', getConfig: 'hm:get-config', connect: 'hm:connect' });
const EMPTY_STATE = Object.freeze({ active: false, playing: false, canNext: false, canPrevious: false, title: '', artist: '' });

function hubURL(value) {
  const url = new URL(value);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Укажите адрес Хаба без пути, параметров и пароля, например https://music.example.ru');
  }
  return url.origin;
}

function sameOrigin(value, origin) {
  try { return !!origin && new URL(value).origin === origin; } catch { return false; }
}

function playerState(value) {
  if (!value || typeof value !== 'object' ||
      !['active', 'playing', 'canNext', 'canPrevious'].every((key) => typeof value[key] === 'boolean') ||
      typeof value.title !== 'string' || typeof value.artist !== 'string') return null;
  if (!value.active) return { ...EMPTY_STATE };
  return { active: true, playing: value.playing, canNext: value.canNext, canPrevious: value.canPrevious,
    title: value.title.slice(0, 300), artist: value.artist.slice(0, 300) };
}

// Button order stays constant: Windows does not allow adding/removing individual buttons after creation.
function thumbbar(state, icons, send) {
  return [
    { tooltip: 'Предыдущий трек', icon: icons.previous, flags: state.active && state.canPrevious ? [] : ['disabled'], click: () => send('previous') },
    { tooltip: state.playing ? 'Пауза' : 'Воспроизвести', icon: state.playing ? icons.pause : icons.play,
      flags: state.active ? [] : ['disabled'], click: () => send('toggle') },
    { tooltip: 'Следующий трек', icon: icons.next, flags: state.active && state.canNext ? [] : ['disabled'], click: () => send('next') },
  ];
}

module.exports = { APP_ID, CHANNELS, EMPTY_STATE, hubURL, sameOrigin, playerState, thumbbar };
