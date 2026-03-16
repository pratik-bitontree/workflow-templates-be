import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { WorkflowService } from './workflow.service';

@Controller('workflow')
export class WorkflowController {
  constructor(private readonly workflowService: WorkflowService) {}

  @Get()
  async list(
    @Query('userId') userId: string,
    @Query('isPrebuilt') isPrebuilt?: string,
  ) {
    const prebuilt = isPrebuilt === 'true' ? true : isPrebuilt === 'false' ? false : undefined;
    return this.workflowService.listWorkflows(userId, prebuilt);
  }

  @Get('history')
  async listHistory(
    @Query('userId') userId: string,
    @Query('workflowId') workflowId?: string,
    @Query('search') search?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    const effectiveUserId = userId || '000000000000000000000001';
    return this.workflowService.listWorkflowRuns({
      userId: effectiveUserId,
      workflowId: workflowId || undefined,
      search: search || undefined,
      limit: limit != null ? parseInt(limit, 10) : 20,
      offset: offset != null ? parseInt(offset, 10) : 0,
    });
  }

  @Get(':id')
  async getOne(
    @Param('id') id: string,
    @Query('userId') userId?: string,
  ) {
    return this.workflowService.getWorkflow(id, userId);
  }

  @Post('create-execution')
  async createExecution(
    @Body() body: { workflowId: string; userId?: string; input?: any[]; previousExecutionId?: string; startNodeId?: string },
  ) {
    const workflowId = body.workflowId;
    const userId = body.userId || '000000000000000000000001';
    if (!workflowId) throw new Error('workflowId is required');

    const payload = await this.workflowService.createWorkflowExecutionPayload(
      workflowId,
      userId,
      body.previousExecutionId,
      body.startNodeId,
    );

    const inputArray = Array.isArray(body.input) ? body.input : body.input ? [body.input] : [];
    const finalPayload = { ...payload, input: inputArray };

    const messageId = await this.workflowService.enqueueWorkflowExecutionPayload(finalPayload);
    return { ...finalPayload, messageId };
  }

  @Get(':id/status/:workflowExecutionId')
  async getStatus(
    @Param('id') workflowId: string,
    @Param('workflowExecutionId') workflowExecutionId: string,
  ) {
    return this.workflowService.getExecutionStatus(workflowId, workflowExecutionId);
  }
}

@Controller('executions')
export class ExecutionController {
  constructor(private readonly workflowService: WorkflowService) {}

  @Get(':id')
  async getExecution(@Param('id') id: string) {
    return this.workflowService.getExecutionById(id);
  }
}
