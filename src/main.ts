import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ensureRedisNoEviction } from './config/redis.config';

// Polyfill for Node < 22: pdfjs-dist and other deps may use Promise.withResolvers
if (typeof (Promise as any).withResolvers === 'undefined') {
  (Promise as any).withResolvers = function withResolvers<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: any) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };
}

async function bootstrap() {
  await ensureRedisNoEviction(process.env);
  const app = await NestFactory.create(AppModule);
  app.enableCors({
    origin: process.env.NODE_ENV === 'production' ? true : ['http://localhost:3000', 'http://127.0.0.1:3000'],
    credentials: true,
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
    allowedHeaders: ['Content-Type', 'Authorization'],
  });
  app.setGlobalPrefix('api', {
    exclude: ['orchestration/(.*)'],
  });
  const port = parseInt(process.env.PORT || '8000', 10);
  await app.listen(port, '0.0.0.0');
  console.log(`Templates Workflow BE (monolithic) running on http://0.0.0.0:${port}`);
}
bootstrap().catch((err) => {
  console.error(err);
  process.exit(1);
});
