import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { BullModule } from '@nestjs/bullmq';
import { NodeExecution, NodeExecutionSchema } from '../schemas/node-execution.schema';
import { UserSecrets, UserSecretsSchema } from '../schemas/user-secrets.schema';
import { WorkflowQueueProcessor } from './workflow-queue.processor';
import { ActionService } from './action.service';
import { NodeExecutorService } from './node-executor.service';
import { ToolsService } from './services/tools.service';
import { GmailService } from './services/gmail.service';
import { InstantlyService } from './services/instantly.service';
import { VercelService } from './services/vercel.service';
import { GsheetsService } from './services/gsheets.service';
import { CalService } from './services/cal.service';
import { ZohoService } from './services/zoho.service';
import { HubspotService } from './services/hubspot/hubspot.service';
import { ApiKeyManager } from './rate-limitting/api-key-manager.service';
import { RateLimiter } from './rate-limitting/rate-limiter.service';
import { CandidateProfileExecutor } from './agent-executor/candidate-profile.executor';
import { RedditSearchExecutor } from './agent-executor/reddit-search.executor';
import { SeoKeywordsExecutor } from './agent-executor/seo-keywords.executor';
import { ImageSanitizationExecutor } from './agent-executor/image-sanitization.executor';
import { CarouselPdfExecutor } from './agent-executor/carousel-pdf.executor';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: NodeExecution.name, schema: NodeExecutionSchema },
      { name: UserSecrets.name, schema: UserSecretsSchema },
    ]),
    BullModule.registerQueue(
      { name: 'workflowQueue' },
      { name: 'nodeCompletionQueue' },
    ),
  ],
  providers: [
    ApiKeyManager,
    RateLimiter,
    ActionService,
    NodeExecutorService,
    WorkflowQueueProcessor,
    ToolsService,
    GmailService,
    InstantlyService,
    VercelService,
    GsheetsService,
    CalService,
    ZohoService,
    HubspotService,
    CandidateProfileExecutor,
    RedditSearchExecutor,
    SeoKeywordsExecutor,
    ImageSanitizationExecutor,
    CarouselPdfExecutor,
  ],
})
export class WorkerModule {}
