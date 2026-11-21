import { forecast } from '../src/weather.ts';

const in14Days = new Date(Date.now() + 14 * 86_400_000);

const checks: Array<{ label: string; where: string; when?: string | Date }> = [
  { label: 'New York today', where: 'New York', when: 'today' },
  { label: 'New York Saturday', where: 'New York', when: 'Saturday' },
  { label: 'Miami tomorrow', where: 'Miami', when: 'tomorrow' },
  { label: 'Tokyo in 14 days', where: 'Tokyo', when: in14Days },
  { label: 'Nonsense city', where: 'Zxqvkjblarg', when: 'today' },
];

for (const check of checks) {
  const res = await forecast(check.where, check.when);
  const lineDisplay = res.line ? res.line : '(empty)';
  console.log(`${check.label} [${res.source}, ok=${res.ok}, ${res.ms}ms]: ${lineDisplay}`);
}
