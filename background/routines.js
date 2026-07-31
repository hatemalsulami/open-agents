// Routines: saved tasks that run on a schedule via chrome.alarms.
//
// A routine is { id, name, prompt, url?, schedule, enabled, lastRun, lastResult }
// schedule is one of:
//   { type: 'daily',    time: 'HH:MM' }
//   { type: 'weekdays', time: 'HH:MM' }               (Mon–Fri)
//   { type: 'weekly',   time: 'HH:MM', day: 0-6 }     (0 = Sunday)
//   { type: 'interval', minutes: N }
//   { type: 'once',     at: ISO string }

const ALARM_PREFIX = 'routine:';

export async function getRoutines() {
  const { routines } = await chrome.storage.local.get('routines');
  return Array.isArray(routines) ? routines : [];
}

async function setRoutines(routines) {
  await chrome.storage.local.set({ routines });
}

export async function saveRoutine(routine) {
  const routines = await getRoutines();
  const entry = {
    id: routine.id || `r${Date.now().toString(36)}`,
    name: (routine.name || '').trim() || 'Untitled routine',
    prompt: (routine.prompt || '').trim(),
    url: (routine.url || '').trim(),
    schedule: routine.schedule,
    enabled: routine.enabled !== false,
    lastRun: routine.lastRun || null,
    lastResult: routine.lastResult || null,
  };
  if (!entry.prompt) throw new Error('A routine needs a task description.');

  const index = routines.findIndex((r) => r.id === entry.id);
  if (index >= 0) routines[index] = { ...routines[index], ...entry };
  else routines.push(entry);

  await setRoutines(routines);
  await scheduleRoutine(entry);
  return entry;
}

export async function deleteRoutine(id) {
  await setRoutines((await getRoutines()).filter((r) => r.id !== id));
  await chrome.alarms.clear(ALARM_PREFIX + id);
}

export async function recordRun(id, result) {
  const routines = await getRoutines();
  const routine = routines.find((r) => r.id === id);
  if (!routine) return;
  routine.lastRun = new Date().toISOString();
  routine.lastResult = (result || '').slice(0, 500);
  if (routine.schedule?.type === 'once') routine.enabled = false;
  await setRoutines(routines);
}

/** Next fire time in epoch ms for a schedule, or null when it can't be scheduled. */
export function nextOccurrence(schedule, from = Date.now()) {
  if (!schedule) return null;

  if (schedule.type === 'interval') {
    const minutes = Math.max(1, Number(schedule.minutes) || 60);
    return from + minutes * 60_000;
  }
  if (schedule.type === 'once') {
    const at = Date.parse(schedule.at);
    return Number.isFinite(at) && at > from ? at : null;
  }

  const [hh, mm] = String(schedule.time || '09:00').split(':').map(Number);
  const candidate = new Date(from);
  candidate.setHours(hh || 0, mm || 0, 0, 0);
  if (candidate.getTime() <= from) candidate.setDate(candidate.getDate() + 1);

  const matches = (date) => {
    const day = date.getDay();
    if (schedule.type === 'weekdays') return day >= 1 && day <= 5;
    if (schedule.type === 'weekly') return day === Number(schedule.day ?? 1);
    return true; // daily
  };
  // At most a week of candidates, so weekly schedules always resolve.
  for (let i = 0; i < 8; i++) {
    if (matches(candidate)) return candidate.getTime();
    candidate.setDate(candidate.getDate() + 1);
  }
  return null;
}

export async function scheduleRoutine(routine) {
  const name = ALARM_PREFIX + routine.id;
  await chrome.alarms.clear(name);
  if (!routine.enabled) return;

  const when = nextOccurrence(routine.schedule);
  if (!when) return;

  if (routine.schedule.type === 'interval') {
    await chrome.alarms.create(name, {
      when,
      periodInMinutes: Math.max(1, Number(routine.schedule.minutes) || 60),
    });
  } else {
    // Non-interval schedules are re-armed after each fire, since "next weekday
    // at 09:00" isn't a fixed period.
    await chrome.alarms.create(name, { when });
  }
}

export async function rescheduleAll() {
  for (const routine of await getRoutines()) await scheduleRoutine(routine);
}

export function routineIdFromAlarm(alarmName) {
  return alarmName.startsWith(ALARM_PREFIX) ? alarmName.slice(ALARM_PREFIX.length) : null;
}

export function describeSchedule(schedule) {
  if (!schedule) return 'not scheduled';
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  switch (schedule.type) {
    case 'daily': return `every day at ${schedule.time}`;
    case 'weekdays': return `weekdays at ${schedule.time}`;
    case 'weekly': return `every ${days[schedule.day ?? 1]} at ${schedule.time}`;
    case 'interval': return `every ${schedule.minutes} min`;
    case 'once': return `once at ${new Date(schedule.at).toLocaleString()}`;
    default: return 'unknown schedule';
  }
}
