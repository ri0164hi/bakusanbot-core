function formatDateWithWeekday(dateStr) {
  if (!dateStr) return '日付不明';
  const normalized = dateStr.replace(/\./g, '/').replace(/-/g, '/');
  const d = new Date(normalized);
  if (Number.isNaN(d.getTime())) return '日付不明';
  const weekdays = ['日','月','火','水','木','金','土'];
  const y = d.getFullYear();
  const m = d.getMonth() + 1;
  const day = d.getDate();
  const w = weekdays[d.getDay()];
  return `${y}年${m}月${day}日(${w})`;
}

function extractImplementationDate(content, fallbackDate) {
  // 本文から「10月6日」「10/6」などを探す
  const match = content.match(/(\d{1,2})[\/月](\d{1,2})日?/);
  if (match) {
    const now = new Date();
    const y = now.getFullYear();
    const m = parseInt(match[1], 10);
    const d = parseInt(match[2], 10);
    return formatDateWithWeekday(`${y}/${m}/${d}`);
  }
  // 本文に日付がなければ一覧の日付を使う
  return formatDateWithWeekday(fallbackDate);
}

module.exports = { formatDateWithWeekday, extractImplementationDate };

