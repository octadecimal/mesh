import { randomUUID } from 'node:crypto';

import { DEVELOPER_REPORT_SCHEMA } from '@mesh/v2-contracts';
import { describe, expect, it, vi } from 'vitest';

import { DeveloperReportConsumer } from './developer-report-consumer.js';

describe('DeveloperReportConsumer', () => {
  it('passes malformed Developer output to settlement as a rejected report', () => {
    const acceptReport = vi.fn();
    const consumer = new DeveloperReportConsumer({
      attempts: { acceptReport },
    });
    const projectId = randomUUID();
    const attemptId = randomUUID();
    const execution = {
      id: randomUUID(),
      assignment: {
        kind: 'developer_task',
        projectId,
        attemptId,
        taskId: randomUUID(),
        taskContractRevision: 1,
        taskCurrentRevision: 1,
        deliveryPlanId: randomUUID(),
        deliveryPlanRevision: 1,
        requirementRevisions: [{ recordId: randomUUID(), recordRevision: 1 }],
        baseCommit: 'a'.repeat(40),
        workspacePath: `C:/mesh/${attemptId}`,
        title: 'Persist Todo items',
        outcome: 'Todo items survive reload.',
        acceptanceCriteria: ['Reload restores one Todo item.'],
        verification: ['Run the Todo persistence test.'],
        expectedArtifacts: ['src/todos.ts'],
        outputSchema: DEVELOPER_REPORT_SCHEMA,
      },
    };
    const event = {
      id: randomUUID(),
      payload: { value: { schema: 'mesh.dev/developer-report/v1' } },
    };

    consumer.structuredOutput(execution as never, event as never);

    expect(acceptReport).toHaveBeenCalledWith(execution, event, null);
  });
});
