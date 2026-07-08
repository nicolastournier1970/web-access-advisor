import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { createApp } from './app.factory.js';
import { getEnv } from './config/env.js';

async function bootstrap(): Promise<void> {
  const env = getEnv();
  const app = await createApp();
  await app.listen(env.API_PORT);
  new Logger('bootstrap').log(
    `Web Access Advisor API listening on http://localhost:${env.API_PORT}/api ` +
      `(docs at /api/docs, llm=${env.LLM_PROVIDER})`,
  );
}

await bootstrap();
