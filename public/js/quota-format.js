'use strict';

const WINDOW_LABELS = {
  five_hour: '5 小時',
  seven_day: '7 天',
};

export function formatTaipeiResetTime(value) {
  if (!value) return '尚無重置時間';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '尚無重置時間';
  const parts = new Intl.DateTimeFormat('zh-TW', {
    timeZone: 'Asia/Taipei',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const part = (type) => parts.find((item) => item.type === type)?.value ?? '';
  return `${part('year')}/${part('month')}/${part('day')} ${part('hour')}:${part('minute')}`;
}

export function formatQuotaDetails(provider) {
  const windows = Array.isArray(provider?.windows) ? provider.windows : [];
  const lines = ['five_hour', 'seven_day'].map((windowName) => {
    const label = WINDOW_LABELS[windowName];
    const window = windows.find((candidate) => candidate?.window === windowName);
    if (!window?.available || !window.remaining) return `${label}：尚無資料`;
    return `${label}：${window.remaining} · ${formatTaipeiResetTime(window.resetAt)}`;
  });
  if (provider?.stale) lines.push('資料可能過期');
  return lines.join('\n');
}

export function selectQuotaSummary(provider) {
  const windows = Array.isArray(provider?.windows) ? provider.windows : [];
  const selected = windows.find((window) => window?.window === 'five_hour' && window.available)
    ?? windows.find((window) => window?.window === 'seven_day' && window.available);
  if (!selected) return null;
  return {
    label: selected.window === 'five_hour' ? '5h' : '7d',
    remaining: selected.remaining,
  };
}
