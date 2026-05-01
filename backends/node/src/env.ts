export interface Env {
  PORT: number;
  DATABASE_URL: string;
  SMTP_HOST: string;
  SMTP_PORT: number;
  SMTP_FROM: string;
  HEARTH_PUBLIC_BASE_URL: string;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

export function loadEnv(): Env {
  return {
    PORT: parseInt(process.env.PORT ?? '5001', 10),
    DATABASE_URL: required('DATABASE_URL'),
    SMTP_HOST: process.env.SMTP_HOST ?? 'localhost',
    SMTP_PORT: parseInt(process.env.SMTP_PORT ?? '1025', 10),
    SMTP_FROM: process.env.SMTP_FROM ?? 'hearth@localhost',
    HEARTH_PUBLIC_BASE_URL: process.env.HEARTH_PUBLIC_BASE_URL ?? 'http://localhost:3000',
  };
}
