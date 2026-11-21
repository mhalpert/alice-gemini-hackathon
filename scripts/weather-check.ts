import { forecast } from '../src/weather.ts';

const in14Days = new Date(Date.now() + 14 * 86_400_000);

const checks: Array<{ label: string; where: string; when?: string | Date }> = [
  { label: 'New York this Saturday', where: 'New York', when: 'this Saturday' },
  { label: 'New York Saturday', where: 'New York', when: 'Saturday' },
  { label: 'New York / this Saturday', where: 'New York / this Saturday' },
  { label: 'Brooklyn rooftop Saturday night', where: 'Brooklyn rooftop', when: 'Saturday night' },
  { label: 'Miami tomorrow (single string)', where: 'Miami tomorrow' },
  { label: 'Tokyo in 14 days', where: 'Tokyo', when: in14Days },
  { label: 'Nonsense city (assumed NY)', where: 'Zxqvkjblarg', when: 'today' },
];

for (const check of checks) {
  const res = await forecast(check.where, check.when);
  const lineDisplay = res.line ? res.line : '(empty)';
  const assumed = res.assumed_place ? ', assumed_place=true' : '';
  console.log(`${check.label} [${res.source}, ok=${res.ok}${assumed}, ${res.ms}ms]: ${lineDisplay}`);
}
