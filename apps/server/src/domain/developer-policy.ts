import type {
  DeveloperBlockerReport,
  DeveloperExecutionCycle,
  DeveloperReviewFeedback,
} from '@mesh-session-platform/contracts';

export const DEVELOPER_POLICY_VERSION = 'developer-policy-v1';

type DeveloperTaskSnapshot = Omit<
  DeveloperExecutionCycle['taskSnapshot'],
  'description'
> & {
  title: string;
  description: string;
};

type Feedback =
  | string
  | Pick<DeveloperReviewFeedback, 'feedback'>
  | Pick<
      DeveloperBlockerReport,
      'reason' | 'evidence' | 'attemptedWork' | 'suggestedHumanAction'
    >;

export type DeveloperPromptInput = Pick<
  DeveloperExecutionCycle,
  'mode' | 'projectInstructions'
> & {
  taskSnapshot: DeveloperTaskSnapshot;
  reviewFeedback?: Feedback | null;
  blockerFeedback?: Feedback | null;
};

const feedbackText = (feedback: Feedback): string => {
  if (typeof feedback === 'string') {
    return feedback;
  }

  if ('feedback' in feedback) {
    return feedback.feedback;
  }

  return [
    `Reason: ${feedback.reason}`,
    `Evidence: ${feedback.evidence}`,
    `Attempted work: ${feedback.attemptedWork}`,
    `Suggested human action: ${feedback.suggestedHumanAction}`,
  ].join('\n');
};

export const composeDeveloperPrompt = (input: DeveloperPromptInput): string => {
  const { taskSnapshot, projectInstructions } = input;
  const sections = [
    `# Mesh Developer execution policy\n\nPolicy version: ${DEVELOPER_POLICY_VERSION}`,
    `## Role and authority\n\nYou are Mesh's Developer. Execute only the assigned task in the authorized workspace and permission mode. You may use only the submit_for_review and mark_blocked controls. Only a human may accept work, request rework, or unblock a task.`,
    `## Safety invariants\n\nRespect Mesh safety, workspace ownership, permission boundaries, and audit-before-publication requirements. Preserve user changes and stop when ownership or scope is ambiguous. Operate through the installed Claude subscription only; do not enable API-key or pay-per-token billing.`,
    `## Task contract\n\nExecution mode: ${input.mode}\n\nTitle: ${taskSnapshot.title}\n\nDescription:\n${taskSnapshot.description}`,
    `## Acceptance criteria\n\n${taskSnapshot.acceptanceCriteria
      .map((criterion) => `- [${criterion.id}] ${criterion.text}`)
      .join('\n')}`,
    `## Project instructions\n\nProject instructions are subordinate to Mesh's safety policy, task scope, workspace boundaries, permission mode, audit requirements, and subscription-only operation.\n\n${projectInstructions.content || '(No project-specific instructions were supplied.)'}`,
  ];

  if (
    input.mode === 'resume' &&
    (input.reviewFeedback || input.blockerFeedback)
  ) {
    const feedback = [input.reviewFeedback, input.blockerFeedback]
      .filter((value): value is Feedback => value != null)
      .map(feedbackText)
      .join('\n\n');
    sections.push(`## Resume feedback\n\n${feedback}`);
  }

  sections.push(
    '## Terminal reporting requirements\n\nBefore stopping, provide structured evidence for every acceptance criterion, verification commands and outcomes, known limitations, and workspace state. Use submit_for_review only when presenting work for human review; use mark_blocked when progress cannot safely continue, with the reason, evidence, attempted work, suggested human action, and workspace-preservation choice. Do not claim human acceptance, rework, or unblocking.',
  );

  return sections.join('\n\n');
};
