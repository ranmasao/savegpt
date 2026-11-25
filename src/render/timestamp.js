/** Timestamp formatting. Pure: no DOM, no chrome APIs. */

function pad(value, width = 2) {
  return String(value).padStart(width, '0');
}

function offsetSuffix(date) {
  const minutes = -date.getTimezoneOffset();
  const sign = minutes >= 0 ? '+' : '-';
  const absolute = Math.abs(minutes);
  return `${sign}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`;
}

/** Full ISO-8601 with local offset. This is what machine attributes always use. */
export function toIso(seconds) {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return null;
  const date = new Date(seconds * 1000);
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    offsetSuffix(date)
  );
}

/**
 * Human-facing rendering. `format` is one of iso | datetime | time | relative.
 * `originSeconds` is the first message's time, used by the relative format.
 */
export function formatHuman(seconds, format, originSeconds) {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return null;

  if (format === 'relative') {
    if (typeof originSeconds !== 'number') return null;
    const delta = Math.max(0, Math.round(seconds - originSeconds));
    const hours = Math.floor(delta / 3600);
    const minutes = Math.floor((delta % 3600) / 60);
    return `+${pad(hours)}:${pad(minutes)}`;
  }

  const date = new Date(seconds * 1000);
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}`;

  if (format === 'iso') return toIso(seconds);
  if (format === 'time') return clock;
  return `${day} ${clock}`; // datetime, the default
}

/** Date stamp used in filenames. */
export function toDateStamp(seconds) {
  const date =
    typeof seconds === 'number' && Number.isFinite(seconds) ? new Date(seconds * 1000) : new Date();
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
