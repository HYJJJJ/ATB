const { mkdir, readFile, writeFile, rename } = require('node:fs/promises');
const path = require('node:path');
const defaults = { enabled: true, showText: true, reminders: true, balance: true, weather: true, news: true, tips: true, city: null, position: null, anchor: null, nextReminderAt: 0 };
function patch(input, current = defaults) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error('桌面助手设置格式无效');
  const next = { ...current };
  for (const key of Object.keys(input)) {
    if (!Object.hasOwn(defaults, key)) throw Error('未知的桌面助手设置');
    if (typeof defaults[key] === 'boolean') { if (typeof input[key] !== 'boolean') throw Error('开关格式无效'); next[key] = input[key]; }
    else if (key === 'city') {
      const city = input.city;
      if (city === null) next.city = null;
      else {
        if (typeof city?.name !== 'string' || !city.name.trim() || city.name.length > 100 || !Number.isFinite(city.latitude) || Math.abs(city.latitude) > 90 || !Number.isFinite(city.longitude) || Math.abs(city.longitude) > 180) throw Error('请选择有效的天气城市');
        next.city = { name: city.name.trim(), latitude: city.latitude, longitude: city.longitude };
      }
    } else if (key === 'position' || key === 'anchor') {
      const point = input[key];
      if (point === null) next[key] = null;
      else { if (!Number.isFinite(point?.x) || !Number.isFinite(point?.y) || Math.abs(point.x) > 100000 || Math.abs(point.y) > 100000) throw Error('桌面位置无效'); next[key] = { x: Math.round(point.x), y: Math.round(point.y) }; }
    } else { if (!Number.isSafeInteger(input[key]) || input[key] < 0) throw Error('提醒时间无效'); next[key] = input[key]; }
  }
  return next;
}
async function loadCompanionSettings(file) {
  let value = { ...defaults }, writes = Promise.resolve();
  try { value = patch(JSON.parse(await readFile(file, 'utf8'))); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  // Older preferences stored the window corner; migrate in memory only.
  if (!value.anchor && value.position) value.anchor = { x:value.position.x + 280, y:value.position.y + 285 };
  return {
    get: () => structuredClone(value),
    update(input) {
      const task = writes.catch(() => {}).then(async () => {
        const next = patch(input, value); await mkdir(path.dirname(file), { recursive: true });
        const temporary = file + '.tmp'; await writeFile(temporary, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 }); await rename(temporary, file); value = next; return structuredClone(value);
      }); writes = task; return task;
    },
    flush: () => writes,
  };
}
module.exports = { loadCompanionSettings };
