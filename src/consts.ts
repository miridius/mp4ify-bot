import { $ } from 'bun';
import { randomBytes } from 'node:crypto';

export const hostname = (await $`hostname`.text()).trim(); // getRequiredEnv('HOSTNAME');

export const secret = randomBytes(32).toString('hex');

const getRequiredEnv = (name: string) => {
  const value = Bun.env[name];
  if (!value) throw new Error(`${name} env var is required`);
  return value;
};
``;
export const botToken = getRequiredEnv('BOT_TOKEN');

export const apiRoot = Bun.env.API_ROOT || 'http://bot-api:8081';
