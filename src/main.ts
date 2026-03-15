import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

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
  const app = await NestFactory.create(AppModule);
  app.enableCors({
    origin: [
      'http://localhost:3000',
      'http://127.0.0.1:3000',
    ],
    credentials: true,
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
    allowedHeaders: ['Content-Type', 'Authorization'],
  });
  app.setGlobalPrefix('api', {
    exclude: ['orchestration/(.*)'],
  });
  const port = process.env.PORT || 8000;
  await app.listen(port);
  console.log(`Templates Workflow BE (monolithic) running on port ${port}`);
}
bootstrap().catch((err) => {
  console.error(err);
  process.exit(1);
});
