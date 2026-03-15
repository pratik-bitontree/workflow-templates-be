import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { BullModule } from '@nestjs/bullmq';
import { getRedisConnectionOptions } from './config/redis.config';
import { WorkflowCacheModule } from './workflow-cache/workflow-cache.module';
import { WorkflowModule } from './workflow/workflow.module';
import { SchedulerModule } from './scheduler/scheduler.module';
import { WorkerModule } from './worker/worker.module';
import { IntegrationHubModule } from './integration-hub/integration-hub.module';

const mongodbUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/templates-workflow';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    MongooseModule.forRoot(mongodbUri, {
      connectionFactory: (connection) => {
        connection.on('error', (err: Error) => {
          console.error('[MongoDB] connection error:', err.message || err);
        });
        connection.on('close', () => {
          console.warn('[MongoDB] connection closed');
        });
        return connection;
      },
    }),
    BullModule.forRoot({
      connection: getRedisConnectionOptions(),
    }),
    WorkflowCacheModule,
    WorkflowModule,
    SchedulerModule,
    WorkerModule,
    IntegrationHubModule,
  ],
})
export class AppModule {}
